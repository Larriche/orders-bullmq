export class NonExistentProductException extends Error {
    public readonly productCode: string;

    constructor(code: string) {
        super(`Product with code ${code} does not exist`);
        this.name = "NonExistentProductException";
        this.productCode = code;
    }
}