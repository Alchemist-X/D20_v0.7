use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::rent::Rent;

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
        current_price: u64, // 当前价格作为参数传入
        expiry: i64,
        amount: u64,
        side: u8, // 0: 高于, 1: 低于
    ) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        let clock = Clock::get()?;

        require!(expiry > clock.unix_timestamp, ErrorCode::InvalidExpiry);
        require!(amount > 0, ErrorCode::InvalidAmount);
        require!(side <= 1, ErrorCode::InvalidSide);
        require!(current_price > 0, ErrorCode::InvalidPrice);

        // 转移SOL到程序账户
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.creator.to_account_info(),
                    to: pool.to_account_info(),
                },
            ),
            amount,
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

        // 转移SOL到程序账户
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.opponent.to_account_info(),
                    to: pool.to_account_info(),
                },
            ),
            amount,
        )?;

        pool.opponent_amount = amount;

        Ok(())
    }

    // 结算赌约 - 只更新状态，不转移资金
    pub fn settle_pool(
        ctx: Context<SettlePool>,
        final_price: u64, // 最终价格作为参数传入
    ) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        let clock = Clock::get()?;

        require!(pool.status == 0, ErrorCode::PoolNotActive);
        require!(clock.unix_timestamp >= pool.expiry, ErrorCode::PoolNotExpired);
        require!(pool.opponent_amount > 0, ErrorCode::PoolNotJoined);
        require!(final_price > 0, ErrorCode::InvalidPrice);

        // 判断胜负
        let creator_wins = if pool.creator_side == 0 {
            final_price > pool.target_price
        } else {
            final_price < pool.target_price
        };

        // 设置获胜者
        if creator_wins {
            pool.winner = Some(pool.creator);
        } else {
            pool.winner = Some(ctx.accounts.opponent.key());
        }

        // 更新状态为已结算
        pool.status = 1;

        Ok(())
    }

    // 提取奖金 - 获胜者调用此函数提取奖金
    pub fn claim_prize(ctx: Context<ClaimPrize>) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        
        require!(pool.status == 1, ErrorCode::PoolNotSettled);
        require!(pool.winner.is_some(), ErrorCode::NoWinner);
        require!(pool.winner.unwrap() == ctx.accounts.winner.key(), ErrorCode::NotWinner);

        // 计算总奖金
        let pool_lamports = pool.to_account_info().lamports();
        let rent = Rent::get()?;
        let rent_exempt_balance = rent.minimum_balance(pool.to_account_info().data_len());
        
        // 只转移超过租金豁免的部分
        if pool_lamports > rent_exempt_balance {
            let prize_amount = pool_lamports - rent_exempt_balance;
            
            // 转移奖金给获胜者
            **pool.to_account_info().try_borrow_mut_lamports()? -= prize_amount;
            **ctx.accounts.winner.try_borrow_mut_lamports()? += prize_amount;
        }

        // 标记奖金已提取
        pool.status = 2; // 2 表示已提取奖金

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
    #[account(
        init,
        payer = creator,
        space = 8 + 32 + 8 + 8 + 32 + 8 + 1 + 8 + 1 + 33,
        seeds = [b"pool", creator.key().as_ref()],
        bump
    )]
    pub pool: Account<'info, GamblingPool>,
    #[account(mut)]
    pub creator: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct JoinPool<'info> {
    #[account(mut)]
    pub pool: Account<'info, GamblingPool>,
    #[account(mut)]
    pub opponent: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettlePool<'info> {
    #[account(mut)]
    pub pool: Account<'info, GamblingPool>,
    /// CHECK: This is safe because we only transfer lamports and do not read/write data
    #[account(mut)]
    pub creator: AccountInfo<'info>,
    /// CHECK: This is safe because we only transfer lamports and do not read/write data
    #[account(mut)]
    pub opponent: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClearPool<'info> {
    #[account(mut)]
    pub pool: Account<'info, GamblingPool>,
}

#[derive(Accounts)]
pub struct ClaimPrize<'info> {
    #[account(mut)]
    pub pool: Account<'info, GamblingPool>,
    #[account(mut)]
    pub winner: Signer<'info>,
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
    #[msg("Pool is not settled yet")]
    PoolNotSettled,
    #[msg("No winner determined")]
    NoWinner,
    #[msg("Not the winner")]
    NotWinner,
}
