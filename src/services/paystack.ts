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
const BANKS_PER_PAGE = 100;
const MAX_BANK_PAGES = 20;
let bankCache: { banks: Bank[]; fetchedAt: number } | null = null;

// Paystack pages the bank list, and Nigeria has a few hundred banks once microfinance banks are included.
// Follows the cursor when Paystack returns one, otherwise page numbers, and stops on a short or repeated page.
async function fetchAllBanks() {
  const banks = new Map<string, Bank>();
  let next: string | undefined;

  for (let page = 1; page <= MAX_BANK_PAGES; page++) {
    const { data } = await client.get("/bank", {
      params: {
        country: "nigeria",
        currency: "NGN",
        perPage: BANKS_PER_PAGE,
        use_cursor: true,
        ...(next ? { next } : { page }),
      },
    });

    const batch: any[] = Array.isArray(data.data) ? data.data : [];
    let added = 0;
    for (const bank of batch) {
      const code = String(bank.code);
      if (bank.active === false || bank.is_deleted || banks.has(code)) continue;
      banks.set(code, { name: String(bank.name), code });
      added++;
    }

    next = data.meta?.next || undefined;
    if (!next && (batch.length < BANKS_PER_PAGE || added === 0)) break;
  }

  return [...banks.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function listBanks(): Promise<Bank[]> {
  if (bankCache && Date.now() - bankCache.fetchedAt < BANK_LIST_TTL_MS) return bankCache.banks;
  try {
    const banks = await fetchAllBanks();
    bankCache = { banks, fetchedAt: Date.now() };
    return banks;
  } catch (err) {
    logPaystackError("list banks", err);
    throw new HttpError(502, "Couldn't load the list of banks. Try again.");
  }
}

// Paystack refused the request (for example, not enough balance for a transfer).
export class PaystackRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaystackRequestError";
  }
}

const paystackMessage = (err: unknown) =>
  axios.isAxiosError(err) && typeof err.response?.data?.message === "string" ? err.response.data.message : null;

export type TransferResult = { status: string; transferCode: string | null; reason?: string };

// Sends money from the Paystack balance. Reusing the same reference never sends a transfer twice.
export async function initiateTransfer({
  amountKobo,
  recipientCode,
  reference,
  reason,
}: {
  amountKobo: number;
  recipientCode: string;
  reference: string;
  reason: string;
}): Promise<TransferResult> {
  try {
    const { data } = await client.post("/transfer", {
      source: "balance",
      amount: amountKobo,
      recipient: recipientCode,
      reference,
      reason,
      currency: "NGN",
    });
    return { status: String(data.data.status), transferCode: data.data.transfer_code ?? null };
  } catch (err) {
    logPaystackError("transfer", err);
    if (axios.isAxiosError(err) && err.response && err.response.status < 500) {
      throw new PaystackRequestError(paystackMessage(err) ?? "Paystack refused the transfer.");
    }
    throw new Error("Couldn't reach Paystack to send the transfer.");
  }
}

// Returns null if Paystack has no transfer with this reference.
export async function verifyTransfer(reference: string): Promise<TransferResult | null> {
  try {
    const { data } = await client.get(`/transfer/verify/${encodeURIComponent(reference)}`);
    return {
      status: String(data.data.status),
      transferCode: data.data.transfer_code ?? null,
      reason: data.data.gateway_response ?? undefined,
    };
  } catch (err) {
    if (axios.isAxiosError(err) && (err.response?.status === 404 || err.response?.status === 400)) return null;
    logPaystackError("verify transfer", err);
    throw new Error("Couldn't reach Paystack to check the transfer.");
  }
}

// Refunds part or all of a card payment back to the customer.
export async function refundTransaction({
  reference,
  amountKobo,
  merchantNote,
}: {
  reference: string;
  amountKobo: number;
  merchantNote: string;
}) {
  try {
    const { data } = await client.post("/refund", {
      transaction: reference,
      amount: amountKobo,
      currency: "NGN",
      merchant_note: merchantNote,
    });
    return { status: String(data.data?.status ?? "pending") };
  } catch (err) {
    logPaystackError("refund", err);
    throw new PaystackRequestError(paystackMessage(err) ?? "Paystack couldn't process the refund.");
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
