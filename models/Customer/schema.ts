import { Schema, model } from "mongoose";
import { ICustomerModel } from "./types";

const customerSchema = new Schema<ICustomerModel>(
  {
    name: { type: String, required: true },
    email: { type: String, required: true },
    phone: { type: String, required: true },
    address: { type: String, required: true },
    welcomedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: "Customers" }
);

export const Customer = model<ICustomerModel>("Customer", customerSchema);