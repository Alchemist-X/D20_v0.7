use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount, Transfer};

declare_id!("YourProgramIDHereReplaceWithActual"); // 用 anchor deploy 后的 program ID 替换

const MIN_SETTLE_DELAY: i64 = 900; // 最小延迟时间（15分钟）
const MAX_SETTLE_DELAY: i64 = 2_592_000; // 最大延迟时间（30天）
const FEE_BPS: u64 = 100; // 清算手续费 1%
const JOIN_FEE_BPS: u64 = 50; // 加注手续费 0.5%

#[program]
pub mod solana_prediction_market {
    use super::*;

    pub fn create_bet(
        ctx: Context<CreateBet>,
        asset: String,
        condition_price: u64,
        condition_gt: bool,
        settle_time: i64,
        initiator_side: bool,
        amount: u64,
    ) -> Result<()> {
        let clock = Clock::get()?;
        require!(
            settle_time > clock.unix_timestamp + MIN_SETTLE_DELAY
                && settle_time < clock.unix_timestamp + MAX_SETTLE_DELAY,
            ErrorCode::InvalidSettleTime
        );

        let bet = &mut ctx.accounts.bet;
        bet.asset = asset;
        bet.condition_price = condition_price;
        bet.condition_gt = condition_gt;
        bet.settle_time = settle_time;
        bet.initiator = ctx.accounts.initiator.key();
        bet.token_mint = ctx.accounts.bet_token.mint;
        bet.initiator_side = initiator_side;
        bet.status = BetStatus::Open;

        if initiator_side {
            bet.yes_pool += amount;
        } else {
            bet.no_pool += amount;
        }

        transfer_tokens(
            ctx.accounts.token_program.to_account_info(),
            &ctx.accounts.initiator_token,
            &ctx.accounts.escrow_token,
            &ctx.accounts.initiator,
            amount,
        )?;

        Ok(())
    }

    pub fn join_bet(ctx: Context<JoinBet>, side: bool, amount: u64) -> Result<()> {
        let bet = &mut ctx.accounts.bet;
        require!(bet.status == BetStatus::Open, ErrorCode::BetClosed);

        let fee = amount * JOIN_FEE_BPS / 10_000;
        let net_amount = amount - fee;

        if side {
            bet.yes_pool += net_amount;
        } else {
            bet.no_pool += net_amount;
        }

        transfer_tokens(
            ctx.accounts.token_program.to_account_info(),
            &ctx.accounts.participant_token,
            &ctx.accounts.escrow_token,
            &ctx.accounts.participant,
            amount,
        )?;

        Ok(())
    }

    pub fn settle_bet(ctx: Context<SettleBet>, price: u64) -> Result<()> {
        let clock = Clock::get()?;
        let bet = &mut ctx.accounts.bet;
        require!(bet.status == BetStatus::Open, ErrorCode::AlreadySettled);
        require!(
            clock.unix_timestamp >= bet.settle_time,
            ErrorCode::NotMature
        );

        let yes_win = if bet.condition_gt {
            price > bet.condition_price
        } else {
            price < bet.condition_price
        };

        let win_pool = if yes_win { bet.yes_pool } else { bet.no_pool };
        let lose_pool = if yes_win { bet.no_pool } else { bet.yes_pool };

        if win_pool == 0 || lose_pool == 0 {
            bet.status = BetStatus::Refunded;
            return Ok(()); // 退还逻辑未实现
        }

        let total_pool = win_pool + lose_pool;
        let fee = total_pool * FEE_BPS / 10_000;
        let _payout_pool = total_pool - fee;

        // 这里只是示意，实际 payout 分配和转账未实现
        bet.status = BetStatus::Settled;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct CreateBet<'info> {
    #[account(init, payer = initiator, space = 8 + 256)]
    pub bet: Account<'info, Bet>,
    #[account(mut)]
    pub initiator: Signer<'info>,
    #[account(mut)]
    pub initiator_token: Account<'info, TokenAccount>,
    #[account(mut)]
    pub escrow_token: Account<'info, TokenAccount>,
    pub bet_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct JoinBet<'info> {
    #[account(mut)]
    pub bet: Account<'info, Bet>,
    #[account(mut)]
    pub participant: Signer<'info>,
    #[account(mut)]
    pub participant_token: Account<'info, TokenAccount>,
    #[account(mut)]
    pub escrow_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SettleBet<'info> {
    #[account(mut)]
    pub bet: Account<'info, Bet>,
    pub oracle_feed: AccountInfo<'info>,
}

#[account]
pub struct Bet {
    pub asset: String,
    pub condition_price: u64,
    pub condition_gt: bool,
    pub settle_time: i64,
    pub initiator: Pubkey,
    pub token_mint: Pubkey,
    pub initiator_side: bool,
    pub yes_pool: u64,
    pub no_pool: u64,
    pub status: BetStatus,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum BetStatus {
    Open,
    Settled,
    Refunded,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Invalid settle time range")]
    InvalidSettleTime,
    #[msg("Bet already settled")]
    AlreadySettled,
    #[msg("Bet not matured yet")]
    NotMature,
    #[msg("Bet is closed")]
    BetClosed,
}

fn transfer_tokens<'info>(
    token_program: AccountInfo<'info>,
    from: &Account<'info, TokenAccount>,
    to: &Account<'info, TokenAccount>,
    authority: &Signer<'info>,
    amount: u64,
) -> Result<()> {
    let cpi_ctx = CpiContext::new(
        token_program,
        Transfer {
            from: from.to_account_info(),
            to: to.to_account_info(),
            authority: authority.to_account_info(),
        },
    );
    anchor_spl::token::transfer(cpi_ctx, amount)
}
