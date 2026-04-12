/**
 * Payment Service SDK Client
 *
 * A lightweight HTTP client for communicating with the fake payment service.
 * This exists as a supporting piece of code to illustrate retry strategies
 * in BullMQ jobs — the payment service randomly returns various error types
 * (timeouts, insufficient funds, maintenance, internal errors, unauthorized),
 * and the ProcessPayment job demonstrates how to handle each with tailored
 * backoff strategies (e.g., short retry for timeouts, long retry for
 * maintenance, unrecoverable for unauthorized).
 *
 * Each error type maps to a specific error class (see errors.ts), allowing
 * job handlers to use instanceof checks for granular retry control.
 */

import {
    PaymentServiceError,
    PaymentMaintenanceError,
    PaymentInternalError,
    PaymentTimeoutError,
    PaymentInsufficientFundsError,
    PaymentUnauthorizedError,
} from "./errors";

export interface ChargeRequest {
    orderId: string;
    amount: number;
    email: string;
}

export interface ChargeResponse {
    status: string;
    transactionId: string;
    orderId: string;
    amount: number;
    email: string;
}

const DEFAULT_BASE_URL = process.env.PAYMENT_SERVICE_URL || "http://payment-service:4000";

export class PaymentServiceClient {
    private baseUrl: string;
    private timeoutMs: number;

    constructor(baseUrl: string = DEFAULT_BASE_URL, timeoutMs = 15000) {
        this.baseUrl = baseUrl.replace(/\/+$/, "");
        this.timeoutMs = timeoutMs;
    }

    public async charge(request: ChargeRequest): Promise<ChargeResponse> {
        let res: Response;

        try {
            res = await fetch(`${this.baseUrl}/payments/charge`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(request),
                signal: AbortSignal.timeout(this.timeoutMs),
            });
        } catch (error: any) {
            if (error.name === "TimeoutError" || error.name === "AbortError") {
                throw new PaymentTimeoutError("Payment request timed out");
            }
            throw new PaymentServiceError(
                `Payment service unreachable: ${error.message}`,
                0,
                "CONNECTION_ERROR",
            );
        }

        if (res.ok) {
            return (await res.json()) as ChargeResponse;
        }

        const body = await res.json().catch(() => ({})) as Record<string, string>;
        const message = body.message || res.statusText;
        const errorCode = body.error || "UNKNOWN_ERROR";

        switch (res.status) {
            case 400:
                if (errorCode === "INSUFFICIENT_FUNDS") {
                    throw new PaymentInsufficientFundsError(message);
                }
                throw new PaymentServiceError(message, 400, errorCode);
            case 401:
                throw new PaymentUnauthorizedError(message);
            case 500:
                throw new PaymentInternalError(message);
            case 503:
                throw new PaymentMaintenanceError(message);
            case 504:
                throw new PaymentTimeoutError(message);
            default:
                throw new PaymentServiceError(message, res.status, errorCode);
        }
    }
}
