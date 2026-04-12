import { Types } from "mongoose";
import { IOrder } from "../Order/types";

export type ProcessingPhase =
  | "payment-processing"
  | "shipping"
  | "shipping_email"
  | "delivery_completed";

export interface IPhaseEntry {
  job_id: string;
  status: "pending" | "in-progress" | "completed" | "failed";
  completedAt: Date | null;
}

export interface IPaymentProviderResponse {
  status: string;
  transactionId: string;
  orderId: string;
  amount: number;
  email: string;
}

export interface IProcessingLogEntry {
  error: string;
  errorCode: string;
  statusCode: number;
  timestamp: Date;
}

export interface IPaymentPhaseEntry extends IPhaseEntry {
  paymentResponse: IPaymentProviderResponse | null;
  logs: IProcessingLogEntry[];
}

export interface IShippingPhaseEntry extends IPhaseEntry {
  shipment_id: string | null;
}

export type IPhases = {
  "payment-processing"?: IPaymentPhaseEntry;
  "shipping"?: IShippingPhaseEntry;
} & {
  [K in Exclude<ProcessingPhase, "payment-processing" | "shipping">]?: IPhaseEntry;
};

export interface IOrderProcessingLog {
  order: Types.ObjectId | IOrder;
  job_id: string;
  phases: IPhases;
}

export interface IOrderProcessingLogModel extends IOrderProcessingLog {
  _id: string;
  createdAt: Date;
  updatedAt: Date;
}
