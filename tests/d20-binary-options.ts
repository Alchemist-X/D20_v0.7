import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { D20BinaryOptions } from "../target/types/d20_binary_options";
import { PublicKey, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { expect } from 'chai';

describe("d20-binary-options", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.D20BinaryOptions as Program<D20BinaryOptions>;
  
  // 测试用的 Pyth 价格账户（SOL/USD）
  const PYTH_PRICE_ACCOUNT = new PublicKey("Gv2VJ1qQ4uT7GkQZ5xVqQ1qY5XqXqXqXqXqXqXqXqXqXq");

  it("Creates a pool", async () => {
    const pool = anchor.web3.Keypair.generate();
    const creator = provider.wallet.publicKey;
    
    const targetPrice = 100 * LAMPORTS_PER_SOL; // 100 SOL
    const expiry = Math.floor(Date.now() / 1000) + 3600; // 1小时后
    const amount = 1 * LAMPORTS_PER_SOL; // 1 SOL
    const side = 0; // 高于

    await program.methods
      .createPool(
        PYTH_PRICE_ACCOUNT,
        new anchor.BN(targetPrice),
        new anchor.BN(expiry),
        new anchor.BN(amount),
        side
      )
      .accounts({
        pool: pool.publicKey,
        creator: creator,
        priceFeed: PYTH_PRICE_ACCOUNT,
        systemProgram: SystemProgram.programId,
      })
      .signers([pool])
      .rpc();

    const poolAccount = await program.account.gamblingPool.fetch(pool.publicKey);
    expect(poolAccount.creator.toString()).to.equal(creator.toString());
    expect(poolAccount.targetPrice.toString()).to.equal(targetPrice.toString());
    expect(poolAccount.creatorAmount.toString()).to.equal(amount.toString());
    expect(poolAccount.creatorSide).to.equal(side);
    expect(poolAccount.status).to.equal(0);
  });

  it("Joins a pool", async () => {
    // 实现加入赌约的测试
  });

  it("Settles a pool", async () => {
    // 实现结算赌约的测试
  });
});
