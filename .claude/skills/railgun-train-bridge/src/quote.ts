import { TrainApiClient } from "@train-protocol/sdk";
import type { AggregatedQuoteResponse, QuoteDetails } from "@train-protocol/sdk";

import {
  ARB_SEPOLIA_CAIP2,
  SEPOLIA_CAIP2,
  TRAIN_SOLVER_API,
  ZERO_ADDRESS
} from "./networks.js";

export type QuoteParams = {
  amountWei: bigint;
  sourceChain?: string;
  destinationChain?: string;
  sourceTokenContract?: string;
  destinationTokenContract?: string;
};

export type BestQuote = {
  solverId: string;
  solverName: string;
  details: QuoteDetails;
  raw: AggregatedQuoteResponse;
};

export async function fetchBestQuote(params: QuoteParams): Promise<BestQuote> {
  const client = new TrainApiClient({ baseUrl: TRAIN_SOLVER_API });

  const response = await client.getQuote({
    amount: params.amountWei.toString(),
    sourceNetwork: params.sourceChain ?? SEPOLIA_CAIP2,
    destinationNetwork: params.destinationChain ?? ARB_SEPOLIA_CAIP2,
    sourceTokenContract: params.sourceTokenContract ?? ZERO_ADDRESS,
    destinationTokenContract: params.destinationTokenContract ?? ZERO_ADDRESS,
    includeReward: true
  });

  const candidates = response.quotes
    .filter((q) => q.quote)
    .map((q) => ({ id: q.solver.id, name: q.solver.name, details: q.quote! }));

  if (candidates.length === 0) {
    const errs = response.errors.map((e) => `${e.solverId}: ${e.message}`).join("; ");
    throw new Error(
      `No quotes returned from solver API. Errors: ${errs || "(none)"}. ` +
        `Check sourceNetwork/destinationNetwork CAIP-2 values, token contracts, and amount.`
    );
  }

  const best =
    response.quotes.find((q) => q.isBest && q.quote)?.quote ??
    candidates.reduce((a, b) =>
      BigInt(a.details.receiveAmount) >= BigInt(b.details.receiveAmount) ? a : b
    ).details;

  const winner = candidates.find((c) => c.details === best);
  if (!winner) {
    throw new Error("Internal error: best quote not in candidates list");
  }

  return {
    solverId: winner.id,
    solverName: winner.name,
    details: best,
    raw: response
  };
}
