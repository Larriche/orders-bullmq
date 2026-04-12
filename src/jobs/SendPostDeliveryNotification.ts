import { ICustomerModel } from "../../models/Customer/types";
import { Order } from "../../models/Order/schema";
import { BaseJob } from "./BaseJob";

export interface ISendPostDeliveryNotificationData {
    orderId: string;
}

export class SendPostDeliveryNotification extends BaseJob<ISendPostDeliveryNotificationData> {
    public readonly defaultQueue: string | null = "notifications";

    public async handle(
        data: ISendPostDeliveryNotificationData,
    ): Promise<void> {
        const order = await Order.findById(data.orderId).populate("customer");
        const customer = order?.customer as ICustomerModel;

        // Simulate sending post-delivery notification to the customer
        console.log(
            `Sending post-delivery notification for order ID: ${data.orderId} to customer ID: ${customer?._id}`,
        );
    }
}
