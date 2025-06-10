use anchor_lang::prelude::*;
use anchor_lang::solana_program::native_token::LAMPORTS_PER_SOL;
use anchor_lang::solana_program::system_instruction;
use pyth_sdk_solana::load_price_feed_from_account_info;

declare_id!("9L4vos4SJyyKtgiVjKsPQxPKbtwYsMuCcbcrkxaLsaQj");

#[program]
pub mod d20_binary_options {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        msg!("Greetings from: {:?}", ctx.program_id);
        Ok(())
    }

    // 创建赌约
    pub fn create_pool(
        ctx: Context<CreatePool>,
        meme_token: Pubkey,
        target_price: u64,
        expiry: i64,
        amount: u64,
        side: u8, // 0: 高于, 1: 低于
    ) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        let clock = Clock::get()?;

        require!(expiry > clock.unix_timestamp, ErrorCode::InvalidExpiry);
        require!(amount > 0, ErrorCode::InvalidAmount);
        require!(side <= 1, ErrorCode::InvalidSide);

        // 验证当前价格
        let price_feed = load_price_feed_from_account_info(&ctx.accounts.price_feed)?;
        let current_price = price_feed.get_current_price().unwrap();
        require!(current_price.price > 0, ErrorCode::InvalidPrice);

        // 转移SOL到程序账户
        let transfer_ix = system_instruction::transfer(
            &ctx.accounts.creator.key(),
            &pool.key(),
            amount,
        );
        anchor_lang::solana_program::program::invoke(
            &transfer_ix,
            &[
                ctx.accounts.creator.to_account_info(),
                pool.to_account_info(),
            ],
        )?;

        pool.meme_token = meme_token;
        pool.target_price = target_price;
        pool.expiry = expiry;
        pool.creator = ctx.accounts.creator.key();
        pool.creator_amount = amount;
        pool.creator_side = side;
        pool.opponent_amount = 0;
        pool.status = 0;
        pool.winner = None;

        Ok(())
    }

    // 参与赌约
    pub fn join_pool(
        ctx: Context<JoinPool>,
        amount: u64,
    ) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        let clock = Clock::get()?;

        require!(pool.status == 0, ErrorCode::PoolNotActive);
        require!(clock.unix_timestamp < pool.expiry, ErrorCode::PoolExpired);
        require!(amount > 0, ErrorCode::InvalidAmount);
        require!(pool.opponent_amount == 0, ErrorCode::PoolAlreadyJoined);

        // 验证当前价格
        let price_feed = load_price_feed_from_account_info(&ctx.accounts.price_feed)?;
        let current_price = price_feed.get_current_price().unwrap();
        require!(current_price.price > 0, ErrorCode::InvalidPrice);

        // 转移SOL到程序账户
        let transfer_ix = system_instruction::transfer(
            &ctx.accounts.opponent.key(),
            &pool.key(),
            amount,
        );
        anchor_lang::solana_program::program::invoke(
            &transfer_ix,
            &[
                ctx.accounts.opponent.to_account_info(),
                pool.to_account_info(),
            ],
        )?;

        pool.opponent_amount = amount;

        Ok(())
    }

    // 结算赌约
    pub fn settle_pool(
        ctx: Context<SettlePool>,
    ) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        let clock = Clock::get()?;

        require!(pool.status == 0, ErrorCode::PoolNotActive);
        require!(clock.unix_timestamp >= pool.expiry, ErrorCode::PoolNotExpired);
        require!(pool.opponent_amount > 0, ErrorCode::PoolNotJoined);

        // 获取当前价格
        let price_feed = load_price_feed_from_account_info(&ctx.accounts.price_feed)?;
        let current_price = price_feed.get_current_price().unwrap();
        require!(current_price.price > 0, ErrorCode::InvalidPrice);

        // 判断胜负
        let creator_wins = if pool.creator_side == 0 {
            current_price.price as u64 > pool.target_price
        } else {
            current_price.price as u64 < pool.target_price
        };

        // 计算收益
        let total_pool = pool.creator_amount + pool.opponent_amount;
        let winner_amount = std::cmp::min(pool.creator_amount, pool.opponent_amount) * 2;

        // 设置获胜者并转移资金
        if creator_wins {
            pool.winner = Some(pool.creator);
            // 转移资金给创建者
            **pool.to_account_info().try_borrow_mut_lamports()? -= winner_amount;
            **ctx.accounts.pool.to_account_info().try_borrow_mut_lamports()? += winner_amount;
        } else {
            pool.winner = Some(ctx.accounts.pool.key());
            // 转移资金给对手
            **pool.to_account_info().try_borrow_mut_lamports()? -= winner_amount;
            **ctx.accounts.pool.to_account_info().try_borrow_mut_lamports()? += winner_amount;
        }

        pool.status = 1;

        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}

// 账户结构
#[account]
pub struct GamblingPool {
    pub meme_token: Pubkey,        // meme币的合约地址
    pub target_price: u64,         // 目标价格k
    pub expiry: i64,              // 到期时间t
    pub creator: Pubkey,          // 创建者
    pub creator_amount: u64,      // 创建者出价金额m
    pub creator_side: u8,         // 创建者预测方向 (0: 高于, 1: 低于)
    pub opponent_amount: u64,     // 对手盘出价金额m1
    pub status: u8,               // 状态 (0: 进行中, 1: 已结算, 2: 已取消)
    pub winner: Option<Pubkey>,   // 获胜者地址
}

#[account]
pub struct UserStake {
    pub pool: Pubkey,
    pub user: Pubkey,
    pub side: u8, // 0: Yes, 1: No
    pub amount: u64,
}

#[account]
pub struct Config {
    pub admin: Pubkey,
    pub fee_vault: Pubkey,
    pub create_fee: u64, // 5 USDT
    pub join_fee_bps: u16, // 0.5% = 50
    pub clearing_fee_bps: u16, // 1% = 100
}

// 指令上下文
#[derive(Accounts)]
pub struct CreatePool<'info> {
    #[account(init, payer = creator, space = 8 + 32 + 8 + 8 + 32 + 8 + 1 + 8 + 1 + 32)]
    pub pool: Account<'info, GamblingPool>,
    #[account(mut)]
    pub creator: Signer<'info>,
    /// CHECK: This is the Pyth price account we want to read
    pub price_feed: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct JoinPool<'info> {
    #[account(mut)]
    pub pool: Account<'info, GamblingPool>,
    #[account(mut)]
    pub opponent: Signer<'info>,
    /// CHECK: This is the Pyth price account we want to read
    pub price_feed: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettlePool<'info> {
    #[account(mut)]
    pub pool: Account<'info, GamblingPool>,
    /// CHECK: This is the Pyth price account we want to read
    pub price_feed: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClearPool<'info> {
    #[account(mut)]
    pub pool: Account<'info, GamblingPool>,
    // TODO: Chainlink 预言机账户、PDA等
}

#[error_code]
pub enum ErrorCode {
    #[msg("Invalid expiry time")]
    InvalidExpiry,
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("Invalid side")]
    InvalidSide,
    #[msg("Pool is not active")]
    PoolNotActive,
    #[msg("Pool has expired")]
    PoolExpired,
    #[msg("Pool is not expired yet")]
    PoolNotExpired,
    #[msg("Pool already has an opponent")]
    PoolAlreadyJoined,
    #[msg("Pool has no opponent yet")]
    PoolNotJoined,
    #[msg("Invalid price from oracle")]
    InvalidPrice,
}
