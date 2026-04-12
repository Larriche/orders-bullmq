export class OutOfStockException extends Error {
    public readonly productId: string;
    public readonly requestedQuantity: number;

    constructor(productCode: string, requestedQuantity: number) {
        super(`Insufficient stock for product ${productCode} (requested: ${requestedQuantity})`);
        this.name = "OutOfStockException";
        this.productId = productCode;
        this.requestedQuantity = requestedQuantity;
    }
}