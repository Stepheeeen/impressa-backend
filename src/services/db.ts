import mongoose, { ClientSession } from "mongoose";

// Runs fn in a MongoDB transaction (retried automatically on transient conflicts) and returns its result.
export async function withTransaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
  let result!: T;
  await mongoose.connection.transaction(async (session) => {
    result = await fn(session);
  });
  return result;
}
