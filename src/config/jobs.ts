/**
 * Job Registry Configuration
 *
 * All job classes registered with oxen-lib. Each class is instantiated
 * and added to the JobsRegistry at bootstrap, making it available for
 * worker processing and outbox poller lookups by name.
 */

import { StartOrderProcessing } from "../jobs/StartOrderProcessing";
import { ProcessPayment } from "../jobs/ProcessPayment";
import { RestockProduct } from "../jobs/RestockProduct";
import { SendCustomerWelcome } from "../jobs/SendCustomerWelcome";
import { SendInsufficientFundsNotification } from "../jobs/SendInsufficientFundsNotification";
import { SendOrderReceivedEmail } from "../jobs/SendOrderReceivedEmail";
import { SendPostDeliveryNotification } from "../jobs/SendPostDeliveryNotification";
import { UpdateShippingStatus } from "../jobs/UpdateShippingStatus";
import { IOxenJobConstructor } from "../oxen-lib/types/job.types";

export const jobs: IOxenJobConstructor[] = [
    StartOrderProcessing,
    ProcessPayment,
    RestockProduct,
    SendCustomerWelcome,
    SendInsufficientFundsNotification,
    SendOrderReceivedEmail,
    SendPostDeliveryNotification,
    UpdateShippingStatus,
];