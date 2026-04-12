import { BaseJob } from "./BaseJob";

export interface ISendInsufficientFundsNotificationData {
    orderId: string;
}

export class SendInsufficientFundsNotification extends BaseJob<ISendInsufficientFundsNotificationData> {
    public readonly defaultQueue: string | null = "notifications";

    public async handle(data: ISendInsufficientFundsNotificationData): Promise<void> {
        // Simulate sending insufficient funds notification to the customer
        console.log(
            `Sending insufficient funds notification for order ID: ${data.orderId}`,
        );
    }
}

