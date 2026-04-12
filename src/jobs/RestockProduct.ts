import { Product } from "../../models/Product/schema";
import { BaseJob } from "./BaseJob";

export interface IRestockProductData {
    event_id: string;
    product_code: string;
    quantity: number;
}

export class RestockProduct extends BaseJob<IRestockProductData> {
    public async handle(data: IRestockProductData): Promise<void> {
        // Update the product quantity in the database
        console.log(
            `Restocking product ${data.product_code} with quantity ${data.quantity}`,
        );

        await Product.findOneAndUpdate(
            { code: data.product_code },
            { $inc: { stock: data.quantity } },
        );
    }

    public id(data: IRestockProductData): string {
        return `restock-product-${data.event_id}`;
    }
}