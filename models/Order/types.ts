import { Types } from "mongoose";
import { IProductModel } from "../Product/types";
import { ICustomerModel } from "../Customer/types";

export enum OrderStatus {
    Pending = "pending",
    PendingPayment = "pending_payment",
    PendingShipping = "pending_shipping",
    Shipped = "shipped",
    Delivered = "delivered",
    Cancelled = "cancelled",
}
export interface IOrder {
    product: Types.ObjectId | IProductModel;
    customer: Types.ObjectId | ICustomerModel;
    quantity: number;
    totalPrice: number;
    status: OrderStatus;
    shippingAddress: string;
    placedAt: Date;
}

export interface IOrderModel extends IOrder {
    _id: string;
    createdAt: Date;
    updatedAt: Date;
}
