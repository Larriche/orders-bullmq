import { BaseJob } from "./BaseJob";

export interface ISendOrderReceivedEmailData {
    orderId: string;
}

export class SendOrderReceivedEmail extends BaseJob<ISendOrderReceivedEmailData> {
    public readonly defaultQueue: string | null = "notifications";
    
    public async handle(data: ISendOrderReceivedEmailData): Promise<void> {
        // Simulate sending order received email to the customer
        console.log(
            `Sending order received email for order ID: ${data.orderId}`,
        );
    }

    public id(data: ISendOrderReceivedEmailData): string {
        return `send-order-received-email-${data.orderId}`;
    }
}