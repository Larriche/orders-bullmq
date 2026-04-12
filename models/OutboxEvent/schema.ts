import { Schema, model } from "mongoose";
import { IOutboxEventModel, OutboxEventStatus } from "./types";

const outboxEventSchema = new Schema<IOutboxEventModel>(
    {
        eventId: { type: String, required: true, unique: true },
        jobName: { type: String, required: true },
        jobData: { type: Schema.Types.Mixed, required: true },
        queue: { type: String, default: null },
        status: {
            type: String,
            enum: Object.values(OutboxEventStatus),
            default: OutboxEventStatus.Pending,
            required: true,
        },
        desiredProcessingTime: { type: Date, required: true },
        processedAt: { type: Date, default: null },
    },
    { timestamps: true, collection: "OutboxEvents" }
);

outboxEventSchema.index({ status: 1, desiredProcessingTime: 1 });

export const OutboxEvent = model<IOutboxEventModel>("OutboxEvent", outboxEventSchema);
