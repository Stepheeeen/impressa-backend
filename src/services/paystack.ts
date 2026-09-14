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
  reference,
}: {
  email: string;
  amountKobo: number;
  metadata: Record<string, unknown>;
  // Our own reference, so wallet credit can be held against it before Paystack is called.
  reference?: string;
}) {
  try {
    const { data } = await client.post("/transaction/initialize", {
      email,
      amount: amountKobo,
      currency: "NGN",
      metadata,
      reference,
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

export type Bank = { name: string; code: string };

const BANK_LIST_TTL_MS = 24 * 60 * 60 * 1000;
let bankCache: { banks: Bank[]; fetchedAt: number } | null = null;

export async function listBanks(): Promise<Bank[]> {
  if (bankCache && Date.now() - bankCache.fetchedAt < BANK_LIST_TTL_MS) return bankCache.banks;
  try {
    const { data } = await client.get("/bank", { params: { country: "nigeria", currency: "NGN" } });
    const banks = (data.data as any[])
      .filter((bank) => bank.active !== false && !bank.is_deleted)
      .map((bank) => ({ name: String(bank.name), code: String(bank.code) }));
    bankCache = { banks, fetchedAt: Date.now() };
    return banks;
  } catch (err) {
    logPaystackError("list banks", err);
    throw new HttpError(502, "Couldn't load the list of banks. Try again.");
  }
}

// Confirms an account number with the bank and returns the name on the account.
export async function resolveBankAccount(accountNumber: string, bankCode: string) {
  try {
    const { data } = await client.get("/bank/resolve", {
      params: { account_number: accountNumber, bank_code: bankCode },
    });
    return { accountName: String(data.data.account_name), accountNumber: String(data.data.account_number) };
  } catch (err) {
    if (axios.isAxiosError(err) && err.response && err.response.status < 500) {
      throw new HttpError(400, "We couldn't verify that account number with the bank. Check the details and try again.");
    }
    logPaystackError("resolve account", err);
    throw new HttpError(502, "Couldn't reach the bank to verify the account. Try again.");
  }
}

// Saves a bank account on Paystack so payouts can be sent to it. Returns the recipient code.
export async function createTransferRecipient({
  name,
  accountNumber,
  bankCode,
}: {
  name: string;
  accountNumber: string;
  bankCode: string;
}) {
  try {
    const { data } = await client.post("/transferrecipient", {
      type: "nuban",
      name,
      account_number: accountNumber,
      bank_code: bankCode,
      currency: "NGN",
    });
    return String(data.data.recipient_code);
  } catch (err) {
    logPaystackError("create transfer recipient", err);
    throw new HttpError(502, "Couldn't save the bank account for payouts. Try again.");
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
