import { Schema, model } from "mongoose";
import { IOrderModel, OrderStatus } from "./types";

const orderSchema = new Schema<IOrderModel>(
  {
    product: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    customer: { type: Schema.Types.ObjectId, ref: "Customer", required: true },
    quantity: { type: Number, required: true },
    totalPrice: { type: Number, required: true },
    status: {
      type: String,
      enum: Object.values(OrderStatus),
      default: OrderStatus.Pending,
      required: true,
    },
    shippingAddress: { type: String, required: true },
    placedAt: { type: Date, default: Date.now, required: true },
  },
  { timestamps: true, collection: "Orders" }
);

export const Order = model<IOrderModel>("Order", orderSchema);