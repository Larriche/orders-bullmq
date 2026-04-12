export class PaymentServiceError extends Error {
    public readonly statusCode: number;
    public readonly errorCode: string;

    constructor(message: string, statusCode: number, errorCode: string) {
        super(message);
        this.name = "PaymentServiceError";
        this.statusCode = statusCode;
        this.errorCode = errorCode;
    }
}

export class PaymentMaintenanceError extends PaymentServiceError {
    constructor(message: string) {
        super(message, 503, "SERVICE_UNAVAILABLE");
        this.name = "PaymentMaintenanceError";
    }
}

export class PaymentInternalError extends PaymentServiceError {
    constructor(message: string) {
        super(message, 500, "INTERNAL_SERVER_ERROR");
        this.name = "PaymentInternalError";
    }
}

export class PaymentTimeoutError extends PaymentServiceError {
    constructor(message: string) {
        super(message, 504, "GATEWAY_TIMEOUT");
        this.name = "PaymentTimeoutError";
    }
}

export class PaymentInsufficientFundsError extends PaymentServiceError {
    constructor(message: string) {
        super(message, 400, "INSUFFICIENT_FUNDS");
        this.name = "PaymentInsufficientFundsError";
    }
}

export class PaymentUnauthorizedError extends PaymentServiceError {
    constructor(message: string) {
        super(message, 401, "UNAUTHORIZED");
        this.name = "PaymentUnauthorizedError";
    }
}
