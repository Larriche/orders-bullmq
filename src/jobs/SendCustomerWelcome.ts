import { BaseJob } from "./BaseJob";

export interface ISendCustomerWelcomeData {
    customerId: string;
}

export class SendCustomerWelcome extends BaseJob<ISendCustomerWelcomeData> {
    public readonly defaultQueue: string | null = "notifications";

    public async handle(data: ISendCustomerWelcomeData): Promise<void> {
        // Simulate sending welcome email to the customer
        console.log(
            `Sending welcome email to customer with ID: ${data.customerId}`,
        );
    }
}
