import { Types } from "mongoose";

export interface IProduct {
    name: string;
    price: number;
    code: string;
    description: string;
    stock: number;
}

export interface IProductModel extends IProduct {
    _id: Types.ObjectId;
    createdAt: Date;
    updatedAt: Date;
}