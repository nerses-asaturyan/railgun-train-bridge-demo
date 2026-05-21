export const SEPOLIA = {
  chainId: 11_155_111,
  caip2: "eip155:11155111",
  rpc: "https://ethereum-sepolia-rpc.publicnode.com",
  wethAddress: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14"
} as const;

export const ARB_SEPOLIA = {
  chainId: 421_614,
  caip2: "eip155:421614",
  rpc: "https://sepolia-rollup.arbitrum.io/rpc"
} as const;

export const TRAIN_SOLVER_API = "https://train-solver-station.dev.lb.layerswap.cloud";

export const POI_NODE_URLS = ["https://ppoi.fdi.network"];

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export const SEPOLIA_CHAIN_ID = SEPOLIA.chainId;
export const ARB_SEPOLIA_CHAIN_ID = ARB_SEPOLIA.chainId;
export const SEPOLIA_CAIP2 = SEPOLIA.caip2;
export const ARB_SEPOLIA_CAIP2 = ARB_SEPOLIA.caip2;
