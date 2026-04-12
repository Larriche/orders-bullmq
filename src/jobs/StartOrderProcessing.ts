import mongoose from "mongoose";
import { BaseJob } from "./BaseJob";
import { Customer } from "../../models/Customer/schema";
import { SendCustomerWelcome } from "./SendCustomerWelcome";
import { Product } from "../../models/Product/schema";
import { Order } from "../../models/Order/schema";
import { OrderProcessingLog } from "../../models/OrderProcessingLog/schema";
import { ICustomerModel } from "../../models/Customer/types";
import { OutOfStockException } from "../exceptions/OutOfStockException";
import { NonExistentProductException } from "../exceptions/NonExistentProductException";
import { SendOrderReceivedEmail } from "./SendOrderReceivedEmail";
import { ProcessPayment } from "./ProcessPayment";

export interface IProcessOrderData {
    event_id: string;
    customer_email: string;
    customer_name: string;
    customer_phone: string;
    product: string;
    quantity: number;
    total_amount: number;
    shipping_address: string;
    payment_email: string;
    placed_at: string;
}
export class StartOrderProcessing extends BaseJob<IProcessOrderData> {
    public readonly defaultQueue: string | null = "orders";

    public unrecoverableErrors = [
        NonExistentProductException,
        mongoose.Error.ValidationError,
    ];

    public async handle(data: IProcessOrderData): Promise<void> {
        // Find existing customer or create new one using upsert
        const customerResult = await Customer.findOneAndUpdate(
            { email: data.customer_email },
            {
                name: data.customer_name,
                phone: data.customer_phone,
                email: data.customer_email,
            },
            { upsert: true, new: true, includeResultMetadata: true },
        );

        const customer = customerResult.value as ICustomerModel;

        if (!customer.welcomedAt) {
            const welcomeSession = await mongoose.startSession();
            welcomeSession.startTransaction();

            try {
                await Customer.updateOne(
                    { _id: customer._id, welcomedAt: null },
                    { $set: { welcomedAt: new Date() } },
                    { session: welcomeSession },
                );

                await SendCustomerWelcome.viaOutbox(welcomeSession).dispatch({
                    customerId: customer._id.toString(),
                });

                await welcomeSession.commitTransaction();
            } catch (err) {
                await welcomeSession.abortTransaction();
                throw err;
            } finally {
                await welcomeSession.endSession();
            }
        }

        const product = await Product.findOne({ code: data.product });

        if (!product) {
            throw new NonExistentProductException(data.product);
        }

        // Check product stock and reduce it and create order atomically using a transaction
        const session = await mongoose.startSession();
        session.startTransaction();

        try {
            const updated = await Product.findOneAndUpdate(
                { _id: product._id, stock: { $gte: data.quantity } },
                { $inc: { stock: -data.quantity } },
                { new: true, session },
            );

            if (!updated) {
                throw new OutOfStockException(
                    product.code,
                    data.quantity,
                );
            }

            const order = (await Order.create(
                [
                    {
                        customer: customer._id,
                        product: product._id,
                        quantity: data.quantity,
                        totalPrice: data.total_amount,
                        status: "pending",
                        shippingAddress: data.shipping_address,
                        placedAt: new Date(data.placed_at),
                    },
                ],
                { session },
            )) as any;

            const processingLog = (await OrderProcessingLog.create(
                [
                    {
                        order: order[0]._id,
                        job_id: this._job!.id,
                        phases: {
                            "payment-processing": {
                                status: "pending",
                                paymentResponse: null,
                                logs: [],
                            },
                        },
                    },
                ],
                { session },
            )) as any;

            const orderId = order[0]._id.toString();
            const processingLogId = processingLog[0]._id.toString();

            await SendOrderReceivedEmail.viaOutbox(session).delay(1000).dispatch({
                orderId,
            });

            await ProcessPayment.viaOutbox(session).dispatch({
                orderId,
                email: data.payment_email,
                amount: data.total_amount,
                processingLogId,
            });

            await session.commitTransaction();
        } catch (error) {
            await session.abortTransaction();
            throw error;
        } finally {
            await session.endSession();
        }
    }

    public backoff(attempts: number, error?: Error): number {
        if (error instanceof OutOfStockException) {
            // Let's see if the product gets restocked in the next 5 hours
            return 1000 * 60 * 60 * 5; // Retry after 5 hours
        }

        // For other errors, use exponential backoff with a max delay of 1 hour
        return super.backoff(attempts, error);
    }

    public id(data: IProcessOrderData): string {
        // Use event_id from the event source as the job id to ensure idempotency at enqueuing stage
        return `process-order-${data.event_id}`;
    }
}
