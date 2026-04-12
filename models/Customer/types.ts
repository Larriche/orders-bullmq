import { Types } from "mongoose";

export interface ICustomer {
  name: string;
  email: string;
  phone: string;
  address: string;
  welcomedAt: Date | null;
}

export interface ICustomerModel extends ICustomer {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}