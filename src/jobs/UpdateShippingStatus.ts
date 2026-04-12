import mongoose from "mongoose";
import { Order } from "../../models/Order/schema";
import { OrderStatus } from "../../models/Order/types";
import { OrderProcessingLog } from "../../models/OrderProcessingLog/schema";
import { BaseJob } from "./BaseJob";
import { SendPostDeliveryNotification } from "./SendPostDeliveryNotification";

export interface IUpdateShippingStatusData {
    order_id: string;
    new_status: OrderStatus.Shipped | OrderStatus.Delivered;
    shipment_id?: string;
    event_id: string;
}

export class UpdateShippingStatus extends BaseJob<IUpdateShippingStatusData> {
    public readonly defaultQueue: string | null = "orders";

    public async handle(data: IUpdateShippingStatusData): Promise<void> {
        console.log(
            `Updating shipping status for order ${data.order_id} to ${data.new_status}`,
        );

        const session = await mongoose.startSession();
        session.startTransaction();

        try {
            await Order.updateOne(
                { _id: data.order_id },
                { $set: { status: data.new_status } },
                { session },
            );

            if (data.new_status === OrderStatus.Shipped) {
                await OrderProcessingLog.updateOne(
                    { order: data.order_id },
                    {
                        $set: {
                            "phases.shipping.status": "completed",
                            "phases.shipping.completedAt": new Date(),
                            "phases.shipping.job_id": this._job?.id || null,
                            "phases.shipping.shipment_id": data.shipment_id || null,
                        },
                    },
                    { session },
                );
            }

            if (data.new_status === OrderStatus.Delivered) {
                await OrderProcessingLog.updateOne(
                    { order: data.order_id },
                    {
                        $set: {
                            "phases.delivery_completed.status": "completed",
                            "phases.delivery_completed.completedAt": new Date(),
                            "phases.delivery_completed.job_id": this._job?.id || null,
                        },
                    },
                    { session },
                );

                await SendPostDeliveryNotification.viaOutbox(session).dispatch({
                    orderId: data.order_id,
                });
            }

            await session.commitTransaction();
        } catch (error) {
            await session.abortTransaction();
            throw error;
        } finally {
            await session.endSession();
        }
    }

    public id(data: IUpdateShippingStatusData): string {
        return `update-shipping-status-${data.event_id}`;
    }
}