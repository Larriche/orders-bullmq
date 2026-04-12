import { Schema, model } from "mongoose";
import { IOrderProcessingLogModel } from "./types";

const phaseEntrySchema = new Schema(
  {
    job_id: { type: String, required: true },
    status: {
      type: String,
      enum: ["pending", "in-progress", "completed", "failed"],
      default: "pending",
      required: true,
    },
    completedAt: { type: Date, default: null },
  },
  { _id: false }
);

const processingLogEntrySchema = new Schema(
  {
    error: { type: String, required: true },
    errorCode: { type: String, required: true },
    statusCode: { type: Number, required: true },
    timestamp: { type: Date, default: Date.now, required: true },
  },
  { _id: false }
);

const paymentProviderResponseSchema = new Schema(
  {
    status: { type: String, required: true },
    transactionId: { type: String, required: true },
    orderId: { type: String, required: true },
    amount: { type: Number, required: true },
    email: { type: String, required: true },
  },
  { _id: false }
);

const paymentPhaseEntrySchema = new Schema(
  {
    job_id: { type: String, required: false },
    status: {
      type: String,
      enum: ["pending", "in-progress", "completed", "failed"],
      default: "pending",
      required: true,
    },
    completedAt: { type: Date, default: null },
    paymentResponse: { type: paymentProviderResponseSchema, default: null },
    logs: { type: [processingLogEntrySchema], default: [] },
  },
  { _id: false }
);

const shippingPhaseEntrySchema = new Schema(
  {
    job_id: { type: String, required: true },
    status: {
      type: String,
      enum: ["pending", "in-progress", "completed", "failed"],
      default: "pending",
      required: true,
    },
    completedAt: { type: Date, default: null },
    shipment_id: { type: String, default: null },
  },
  { _id: false }
);

const orderProcessingLogSchema = new Schema<IOrderProcessingLogModel>(
  {
    order: { type: Schema.Types.ObjectId, ref: "Order", required: true },
    job_id: { type: String, required: true },
    phases: {
      "payment-processing": { type: paymentPhaseEntrySchema, default: undefined },
      shipping: { type: shippingPhaseEntrySchema, default: undefined },
      shipping_email: { type: phaseEntrySchema, default: undefined },
      delivery_completed: { type: phaseEntrySchema, default: undefined },
    },
  },
  { timestamps: true, collection: "OrderProcessingLogs" }
);

export const OrderProcessingLog = model<IOrderProcessingLogModel>(
  "OrderProcessingLog",
  orderProcessingLogSchema
);
