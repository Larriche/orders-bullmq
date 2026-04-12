const express = require("express");

const app = express();
app.use(express.json());

let mode = "normal";

// Set service mode
app.post("/mode", (req, res) => {
  const validModes = ["normal", "maintenance", "error", "slow", "insufficient-funds", "unauthorized"];
  const requested = req.body.mode;

  if (!validModes.includes(requested)) {
    return res.status(400).json({
      error: `Invalid mode "${requested}". Valid modes: ${validModes.join(", ")}`,
    });
  }

  mode = requested;
  res.json({ message: `Mode set to "${mode}"` });
});

// Get current mode
app.get("/mode", (_req, res) => {
  res.json({ mode });
});

// Process payment endpoint
app.post("/payments/charge", (req, res) => {
  const { orderId, amount, email } = req.body;

  switch (mode) {
    case "maintenance":
      return res.status(503).json({
        error: "SERVICE_UNAVAILABLE",
        message: "Payment service is under maintenance. Please try again later.",
      });

    case "error":
      return res.status(500).json({
        error: "INTERNAL_SERVER_ERROR",
        message: "An unexpected error occurred while processing the payment.",
      });

    case "slow": {
      // Randomly either timeout (delay 30s+) or succeed slowly
      const willTimeout = Math.random() < 0.6;
      if (willTimeout) {
        const delay = 30000 + Math.random() * 30000;
        return setTimeout(() => {
          res.status(504).json({
            error: "GATEWAY_TIMEOUT",
            message: "Payment processing timed out.",
          });
        }, delay);
      }
      // Slow but succeeds
      const slowDelay = 3000 + Math.random() * 5000;
      return setTimeout(() => {
        res.json({
          status: "success",
          transactionId: `txn_${Date.now()}`,
          orderId,
          amount,
          email,
        });
      }, slowDelay);
    }

    case "insufficient-funds":
      return res.status(400).json({
        error: "INSUFFICIENT_FUNDS",
        message: "The payment method has insufficient funds to complete this transaction.",
        orderId,
        amount,
      });

    case "unauthorized":
      return res.status(401).json({
        error: "UNAUTHORIZED",
        message: "Authentication failed. Invalid or missing API credentials.",
      });

    case "normal":
    default:
      return res.json({
        status: "success",
        transactionId: `txn_${Date.now()}`,
        orderId,
        amount,
        email,
      });
  }
});

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`Fake Payment Service running on port ${port}`);
  console.log(`Current mode: ${mode}`);
});
