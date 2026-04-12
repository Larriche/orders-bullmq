import { Schema, model } from "mongoose";
import { IProductModel } from "./types";

const productSchema = new Schema<IProductModel>(
  {
    name: { type: String, required: true },
    price: { type: Number, required: true },
    code: { type: String, required: true, unique: true },
    description: { type: String, required: true },
    stock: { type: Number, required: true },
  },
  { timestamps: true, collection: "Products" }
);

export const Product = model<IProductModel>("Products", productSchema);