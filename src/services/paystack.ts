import axios from "axios";
import { env } from "../config/env";
import { HttpError } from "../middleware/errorHandler";

const client = axios.create({
  baseURL: "https://api.paystack.co",
  timeout: 15_000,
  headers: { Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}` },
});

export type PaystackTransaction = {
  reference: string;
  status: string;
  amount: number; // kobo
  currency: string;
  customer?: { email?: string };
  metadata?: unknown;
  gateway_response?: string;
};

function logPaystackError(action: string, err: unknown) {
  const detail = axios.isAxiosError(err) ? err.response?.data ?? err.message : err;
  console.error(`Paystack ${action} failed:`, detail);
}

export async function initializeTransaction({
  email,
  amountKobo,
  metadata,
}: {
  email: string;
  amountKobo: number;
  metadata: Record<string, unknown>;
}) {
  try {
    const { data } = await client.post("/transaction/initialize", {
      email,
      amount: amountKobo,
      currency: "NGN",
      metadata,
    });
    return {
      authorizationUrl: data.data.authorization_url as string,
      reference: data.data.reference as string,
    };
  } catch (err) {
    logPaystackError("initialize", err);
    throw new HttpError(502, "Couldn't start the payment. Please try again.");
  }
}

// Returns null when Paystack doesn't recognise the reference.
export async function verifyTransaction(reference: string): Promise<PaystackTransaction | null> {
  try {
    const { data } = await client.get(`/transaction/verify/${encodeURIComponent(reference)}`);
    return data.data as PaystackTransaction;
  } catch (err) {
    if (axios.isAxiosError(err) && (err.response?.status === 400 || err.response?.status === 404)) {
      return null;
    }
    logPaystackError("verify", err);
    throw new HttpError(502, "Couldn't check the payment with Paystack. Please try again.");
  }
}
