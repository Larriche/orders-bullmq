import mongoose from "mongoose";
import { BaseJob } from "./BaseJob";
import {
    PaymentInsufficientFundsError,
    PaymentInternalError,
    PaymentMaintenanceError,
    PaymentServiceClient,
    PaymentServiceError,
    PaymentTimeoutError,
    PaymentUnauthorizedError,
} from "../payment-service-sdk";
import { OrderProcessingLog } from "../../models/OrderProcessingLog/schema";
import { Order } from "../../models/Order/schema";
import { OrderStatus } from "../../models/Order/types";
import { SendInsufficientFundsNotification } from "./SendInsufficientFundsNotification";

export interface IProcessPaymentData {
    orderId: string;
    amount: number;
    email: string;
    processingLogId: string;
}
export class ProcessPayment extends BaseJob<IProcessPaymentData> {
    public readonly defaultQueue: string | null = "payments";
    public unrecoverableErrors = [PaymentUnauthorizedError];

    public async handle(data: IProcessPaymentData): Promise<void> {
        const log = await OrderProcessingLog.findById(data.processingLogId);

        if (log?.phases?.["payment-processing"]?.status === "completed") {
            console.log(`Payment already completed for order ${data.orderId}, skipping`);
            return;
        }

        try {
            await OrderProcessingLog.updateOne(
                { _id: data.processingLogId },
                {
                    $set: {
                        "phases.payment-processing.status": "in-progress",
                        "phases.payment-processing.job_id":
                            this._job?.id || null,
                    },
                },
            );

            const client = new PaymentServiceClient();

            // Payment service is assumed to be idempotent and as long as pass the same orderId,
            // we don't need to worry about multiple charges here
            const result = await client.charge({
                orderId: data.orderId,
                amount: data.amount,
                email: data.email,
            });

            const session = await mongoose.startSession();
            session.startTransaction();

            try {
                await OrderProcessingLog.updateOne(
                    { _id: data.processingLogId },
                    {
                        $set: {
                            "phases.payment-processing.status": "completed",
                            "phases.payment-processing.completedAt": new Date(),
                            "phases.payment-processing.paymentResponse": result,
                            "phases.payment-processing.job_id":
                                this._job?.id || null,
                        },
                    },
                    { session },
                );

                await Order.updateOne(
                    { _id: data.orderId },
                    { $set: { status: OrderStatus.PendingShipping } },
                    { session },
                );

                await session.commitTransaction();
            } catch (err) {
                await session.abortTransaction();
                throw err;
            } finally {
                await session.endSession();
            }

            console.log(
                `Payment processed for order ${data.orderId}: transactionId=${result.transactionId}`,
            );
        } catch (error) {
            if (error instanceof PaymentServiceError) {
                await OrderProcessingLog.updateOne(
                    { _id: data.processingLogId },
                    {
                        $push: {
                            "phases.payment-processing.logs": {
                                error: error.message,
                                errorCode: error.errorCode,
                                statusCode: error.statusCode,
                                timestamp: new Date(),
                            },
                        },
                    },
                );
            }

            // If insufficient funds, notify the user and update order status
            if (error instanceof PaymentInsufficientFundsError) {
                const session = await mongoose.startSession();
                session.startTransaction();

                try {
                    await Order.updateOne(
                        { _id: data.orderId },
                        { $set: { status: OrderStatus.PendingPayment } },
                        { session },
                    );

                    await SendInsufficientFundsNotification.viaOutbox(session).dispatch({
                        orderId: data.orderId,
                    });

                    await session.commitTransaction();
                } catch (err) {
                    await session.abortTransaction();
                    throw err;
                } finally {
                    await session.endSession();
                }
            }

            throw error;
        }
    }

    public backoff(attempts: number, error?: Error): number {
        if (error instanceof PaymentInsufficientFundsError) {
            // Retry again in 5 hours
            return 1000 * 60 * 60 * 5;
        }

        if (error instanceof PaymentTimeoutError) {
            // Retry after 1 minute
            return 1000 * 60 * 1;
        }

        if (error instanceof PaymentInternalError) {
            // Retry after 5 minutes
            return 1000 * 60 * 5;
        }

        if (error instanceof PaymentMaintenanceError) {
            return 1000 * 60 * 60; // Retry after 1 hour
        }

        // For other errors, use exponential backoff with a max delay of 1 hour
        const delay = Math.pow(2, attempts) * 1000;
        return Math.min(delay, 1000 * 60 * 60);
    }

    public id(data: IProcessPaymentData): string {
        return `process-order-payment-${data.orderId}`;
    }
}
