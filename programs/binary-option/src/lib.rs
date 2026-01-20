use anchor_lang::prelude::*;

declare_id!("ATvmQTJT6JV9eYvBeyDacN9tGUKA4P5ykmxF9zK49CFr");

/// Maximum number of options per market (2-10 as per PRD)
pub const MAX_OPTIONS: usize = 10;
/// Maximum question length
pub const MAX_QUESTION_LEN: usize = 256;
/// Maximum option label length
pub const MAX_OPTION_LEN: usize = 64;

#[program]
pub mod social_bet {
    use super::*;

    /// Initialize the global config (admin settings)
    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        admin: Pubkey,
        fee_vault: Pubkey,
        create_fee: u64,
        join_fee_bps: u16,
        clearing_fee_bps: u16,
        settle_fee_bps: u16,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.admin = admin;
        config.fee_vault = fee_vault;
        config.create_fee = create_fee;
        config.join_fee_bps = join_fee_bps;
        config.clearing_fee_bps = clearing_fee_bps;
        config.settle_fee_bps = settle_fee_bps;
        config.next_market_id = 1;
        Ok(())
    }

    /// Update config (admin only)
    pub fn update_config(
        ctx: Context<UpdateConfig>,
        fee_vault: Pubkey,
        create_fee: u64,
        join_fee_bps: u16,
        clearing_fee_bps: u16,
        settle_fee_bps: u16,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.fee_vault = fee_vault;
        config.create_fee = create_fee;
        config.join_fee_bps = join_fee_bps;
        config.clearing_fee_bps = clearing_fee_bps;
        config.settle_fee_bps = settle_fee_bps;
        Ok(())
    }

    /// Set a new admin (admin only)
    pub fn set_admin(ctx: Context<SetAdmin>, new_admin: Pubkey) -> Result<()> {
        let config = &mut ctx.accounts.config;
        require!(new_admin != Pubkey::default(), ErrorCode::InvalidAdmin);

        let old_admin = config.admin;
        config.admin = new_admin;

        emit!(AdminChanged {
            old_admin,
            new_admin,
        });

        Ok(())
    }

    /// Create a new prediction market
    /// 
    /// # Arguments
    /// * `question` - The prediction question
    /// * `options` - Array of option labels (2-10 options)
    /// * `stake_amount` - Fixed bet amount in lamports
    /// * `bet_deadline` - Timestamp when betting closes
    /// * `resolve_time` - Timestamp when settlement can begin
    /// * `challenge_window` - Duration in seconds for the challenge period
    pub fn create_market(
        ctx: Context<CreateMarket>,
        question: String,
        options: Vec<String>,
        stake_amount: u64,
        bet_deadline: i64,
        resolve_time: i64,
        challenge_window: u64,
    ) -> Result<()> {
        let market = &mut ctx.accounts.market;
        let config = &mut ctx.accounts.config;
        let clock = Clock::get()?;

        // Validations
        require!(question.len() <= MAX_QUESTION_LEN, ErrorCode::QuestionTooLong);
        require!(options.len() >= 2 && options.len() <= MAX_OPTIONS, ErrorCode::InvalidOptionsCount);
        for opt in &options {
            require!(opt.len() <= MAX_OPTION_LEN, ErrorCode::OptionTooLong);
        }
        require!(stake_amount >= MIN_STAKE_AMOUNT, ErrorCode::StakeTooSmall);
        require!(bet_deadline > clock.unix_timestamp, ErrorCode::InvalidBetDeadline);
        require!(resolve_time >= bet_deadline, ErrorCode::InvalidResolveTime);
        require!(challenge_window > 0, ErrorCode::InvalidChallengeWindow);

        // Get market ID
        let market_id = config.next_market_id;
        config.next_market_id = config.next_market_id.checked_add(1).ok_or(ErrorCode::Overflow)?;

        // Transfer create fee to fee vault
        let create_fee = config.create_fee;
        if create_fee > 0 {
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.creator.to_account_info(),
                        to: ctx.accounts.fee_vault.to_account_info(),
                    },
                ),
                create_fee,
            )?;
        }

        // Initialize market
        market.id = market_id;
        market.creator = ctx.accounts.creator.key();
        market.question = question;
        market.options_count = options.len() as u8;
        
        // Store options (pad with empty strings if needed)
        let mut stored_options = [
            String::new(), String::new(), String::new(), String::new(), String::new(),
            String::new(), String::new(), String::new(), String::new(), String::new(),
        ];
        for (i, opt) in options.iter().enumerate() {
            stored_options[i] = opt.clone();
        }
        market.options = stored_options;
        
        // Initialize vote counts
        market.option_totals = [0u64; MAX_OPTIONS];
        market.option_participants = [0u32; MAX_OPTIONS];
        
        market.stake_amount = stake_amount;
        market.bet_deadline = bet_deadline;
        market.resolve_time = resolve_time;
        market.challenge_window = challenge_window;
        market.status = MarketStatus::Open as u8;
        market.proposed_outcome = None;
        market.proposer = None;
        market.challenge_end_time = None;
        market.final_outcome = None;
        market.created_at = clock.unix_timestamp;
        market.total_pool = 0;

        emit!(MarketCreated {
            market: market.key(),
            market_id,
            creator: market.creator,
            question: market.question.clone(),
            options_count: market.options_count,
            stake_amount,
            bet_deadline,
            resolve_time,
            challenge_window,
        });

        Ok(())
    }

    /// Place a bet on a market option
    /// 
    /// Each address can bet on only ONE option per market.
    /// Multiple bets on the same option accumulate the stake amount.
    pub fn place_bet(
        ctx: Context<PlaceBet>,
        market_id: u64,
        option_index: u8,
    ) -> Result<()> {
        let market = &mut ctx.accounts.market;
        let user_bet = &mut ctx.accounts.user_bet;
        let config = &ctx.accounts.config;
        let clock = Clock::get()?;

        // Validations
        require!(market.id == market_id, ErrorCode::InvalidMarketId);
        require!(market.status == MarketStatus::Open as u8, ErrorCode::MarketNotOpen);
        require!(clock.unix_timestamp < market.bet_deadline, ErrorCode::BettingClosed);
        require!((option_index as usize) < market.options_count as usize, ErrorCode::InvalidOptionIndex);

        let stake = market.stake_amount;

        // Calculate join fee
        let join_fee = stake
            .checked_mul(config.join_fee_bps as u64)
            .ok_or(ErrorCode::Overflow)?
            .checked_div(10000)
            .ok_or(ErrorCode::Overflow)?;

        // Check if this is a new bet or additional bet
        if user_bet.amount == 0 {
            // First bet - set the option
            user_bet.market_id = market_id;
            user_bet.user = ctx.accounts.user.key();
            user_bet.option_index = option_index;
            user_bet.amount = stake;
            user_bet.claimed = false;
            user_bet.bet_count = 1;

            // Update market stats
            market.option_participants[option_index as usize] = market.option_participants[option_index as usize]
                .checked_add(1).ok_or(ErrorCode::Overflow)?;
        } else {
            // Additional bet - must be same option
            require!(user_bet.option_index == option_index, ErrorCode::CannotChangeOption);
            user_bet.amount = user_bet.amount.checked_add(stake).ok_or(ErrorCode::Overflow)?;
            user_bet.bet_count = user_bet.bet_count.checked_add(1).ok_or(ErrorCode::Overflow)?;
        }

        // Update market pool
        market.option_totals[option_index as usize] = market.option_totals[option_index as usize]
            .checked_add(stake).ok_or(ErrorCode::Overflow)?;
        market.total_pool = market.total_pool.checked_add(stake).ok_or(ErrorCode::Overflow)?;

        // Transfer stake to market account
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.user.to_account_info(),
                    to: market.to_account_info(),
                },
            ),
            stake,
        )?;

        // Transfer join fee to fee vault
        if join_fee > 0 {
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.user.to_account_info(),
                        to: ctx.accounts.fee_vault.to_account_info(),
                    },
                ),
                join_fee,
            )?;
        }

        emit!(BetPlaced {
            market: market.key(),
            market_id,
            user: ctx.accounts.user.key(),
            option_index,
            amount: stake,
            total_user_amount: user_bet.amount,
        });

        Ok(())
    }

    /// Initiate settlement by proposing an outcome
    /// 
    /// Can be called at any time by any bettor (early resolution allowed)
    pub fn initiate_settlement(
        ctx: Context<InitiateSettlement>,
        market_id: u64,
        proposed_outcome: u8,
    ) -> Result<()> {
        let market = &mut ctx.accounts.market;
        let user_bet = &ctx.accounts.user_bet;
        let clock = Clock::get()?;

        // Validations
        require!(market.id == market_id, ErrorCode::InvalidMarketId);
        require!(market.status == MarketStatus::Open as u8 || market.status == MarketStatus::Closed as u8, 
            ErrorCode::InvalidMarketStatus);
        // Note: Early resolution is allowed - no resolve_time check
        require!((proposed_outcome as usize) < market.options_count as usize, ErrorCode::InvalidOptionIndex);
        
        // Proposer must have placed a bet
        require!(user_bet.market_id == market_id, ErrorCode::InvalidMarketId);
        require!(user_bet.amount > 0, ErrorCode::MustBeBettor);

        // Update market status
        market.status = MarketStatus::Proposed as u8;
        market.proposed_outcome = Some(proposed_outcome);
        market.proposer = Some(ctx.accounts.proposer.key());
        market.challenge_end_time = Some(clock.unix_timestamp + market.challenge_window as i64);

        emit!(SettlementProposed {
            market: market.key(),
            market_id,
            proposer: ctx.accounts.proposer.key(),
            proposed_outcome,
            challenge_end_time: market.challenge_end_time.unwrap(),
        });

        Ok(())
    }

    /// Challenge a proposed settlement
    /// 
    /// Any user can challenge during the challenge window
    pub fn challenge_settlement(
        ctx: Context<ChallengeSettlement>,
        market_id: u64,
    ) -> Result<()> {
        let market = &mut ctx.accounts.market;
        let clock = Clock::get()?;

        // Validations
        require!(market.id == market_id, ErrorCode::InvalidMarketId);
        require!(market.status == MarketStatus::Proposed as u8, ErrorCode::MarketNotProposed);
        require!(market.challenge_end_time.is_some(), ErrorCode::NoChallengeWindow);
        require!(clock.unix_timestamp < market.challenge_end_time.unwrap(), ErrorCode::ChallengeWindowClosed);

        // Update market status to disputed
        market.status = MarketStatus::Disputed as u8;

        emit!(SettlementChallenged {
            market: market.key(),
            market_id,
            challenger: ctx.accounts.challenger.key(),
        });

        Ok(())
    }

    /// Finalize settlement after challenge window passes without challenge
    /// 
    /// Any bettor can call this after challenge_end_time
    pub fn finalize_settlement(
        ctx: Context<FinalizeSettlement>,
        market_id: u64,
    ) -> Result<()> {
        let market = &mut ctx.accounts.market;
        let user_bet = &ctx.accounts.user_bet;
        let clock = Clock::get()?;

        // Validations
        require!(market.id == market_id, ErrorCode::InvalidMarketId);
        require!(market.status == MarketStatus::Proposed as u8, ErrorCode::MarketNotProposed);
        require!(market.challenge_end_time.is_some(), ErrorCode::NoChallengeWindow);
        require!(clock.unix_timestamp >= market.challenge_end_time.unwrap(), ErrorCode::ChallengeWindowNotEnded);
        
        // Caller must be a bettor
        require!(user_bet.market_id == market_id, ErrorCode::InvalidMarketId);
        require!(user_bet.amount > 0, ErrorCode::MustBeBettor);

        // Finalize with proposed outcome
        market.status = MarketStatus::Settled as u8;
        market.final_outcome = market.proposed_outcome;

        emit!(MarketSettled {
            market: market.key(),
            market_id,
            outcome: market.final_outcome.unwrap(),
            settled_by: ctx.accounts.caller.key(),
            is_admin_resolution: false,
        });

        Ok(())
    }

    /// Admin resolves a disputed market
    /// 
    /// Only admin can call this when market is in DISPUTED status
    pub fn resolve_dispute(
        ctx: Context<ResolveDispute>,
        _market_id: u64,
        final_outcome: u8,
    ) -> Result<()> {
        let market = &mut ctx.accounts.market;

        // Validations (admin check is in account constraint)
        require!(market.status == MarketStatus::Disputed as u8, ErrorCode::MarketNotDisputed);
        require!((final_outcome as usize) < market.options_count as usize, ErrorCode::InvalidOptionIndex);

        // Set final outcome
        market.status = MarketStatus::Settled as u8;
        market.final_outcome = Some(final_outcome);

        emit!(MarketSettled {
            market: market.key(),
            market_id: market.id,
            outcome: final_outcome,
            settled_by: ctx.accounts.admin.key(),
            is_admin_resolution: true,
        });

        Ok(())
    }

    /// Claim prize for winning bettors
    pub fn claim_prize(ctx: Context<ClaimPrize>, market_id: u64) -> Result<()> {
        let market = &mut ctx.accounts.market;
        let user_bet = &mut ctx.accounts.user_bet;
        let config = &ctx.accounts.config;

        // Validations
        require!(market.status == MarketStatus::Settled as u8, ErrorCode::MarketNotSettled);
        require!(market.final_outcome.is_some(), ErrorCode::NoOutcome);
        require!(!user_bet.claimed, ErrorCode::AlreadyClaimed);
        require!(user_bet.option_index == market.final_outcome.unwrap(), ErrorCode::NotWinner);

        // Calculate winnings
        let winning_option = market.final_outcome.unwrap() as usize;
        let winning_pool = market.option_totals[winning_option];
        require!(winning_pool > 0, ErrorCode::NoWinners);

        let total_pool = market.total_pool;
        
        // User's share = (user_bet / winning_pool) * total_pool
        let user_share = (total_pool as u128)
            .checked_mul(user_bet.amount as u128)
            .ok_or(ErrorCode::Overflow)?
            .checked_div(winning_pool as u128)
            .ok_or(ErrorCode::Overflow)? as u64;

        // Calculate clearing fee
        let clearing_fee = user_share
            .checked_mul(config.clearing_fee_bps as u64)
            .ok_or(ErrorCode::Overflow)?
            .checked_div(10000)
            .ok_or(ErrorCode::Overflow)?;

        let user_payout = user_share.checked_sub(clearing_fee).ok_or(ErrorCode::Overflow)?;

        // CEI Pattern: Update state BEFORE transfers
        user_bet.claimed = true;

        // Transfer clearing fee to fee vault
        if clearing_fee > 0 {
            let market_balance = market.to_account_info().lamports();
            require!(market_balance >= clearing_fee, ErrorCode::InsufficientFunds);
            **market.to_account_info().try_borrow_mut_lamports()? -= clearing_fee;
            **ctx.accounts.fee_vault.try_borrow_mut_lamports()? += clearing_fee;
        }

        // Transfer winnings to user
        if user_payout > 0 {
            let market_balance = market.to_account_info().lamports();
            require!(market_balance >= user_payout, ErrorCode::InsufficientFunds);
            **market.to_account_info().try_borrow_mut_lamports()? -= user_payout;
            **ctx.accounts.user.try_borrow_mut_lamports()? += user_payout;
        }

        emit!(PrizeClaimed {
            market: market.key(),
            market_id,
            user: ctx.accounts.user.key(),
            amount: user_payout,
            fee: clearing_fee,
        });

        Ok(())
    }

    /// Refund bets if no outcome is proposed within 7 days after resolve_time
    pub fn refund_bet(ctx: Context<RefundBet>, market_id: u64) -> Result<()> {
        let market = &mut ctx.accounts.market;
        let user_bet = &mut ctx.accounts.user_bet;
        let clock = Clock::get()?;

        // Validations
        require!(!user_bet.claimed, ErrorCode::AlreadyClaimed);

        // Refund condition: 7 days passed after resolve_time and still OPEN or CLOSED
        let refund_deadline = market.resolve_time + (7 * 24 * 3600);
        require!(
            clock.unix_timestamp >= refund_deadline && 
            (market.status == MarketStatus::Open as u8 || market.status == MarketStatus::Closed as u8),
            ErrorCode::RefundNotAvailable
        );

        let refund_amount = user_bet.amount;

        // CEI Pattern: Update state BEFORE transfers
        user_bet.claimed = true;

        // Transfer refund to user
        if refund_amount > 0 {
            let market_balance = market.to_account_info().lamports();
            require!(market_balance >= refund_amount, ErrorCode::InsufficientFunds);
            **market.to_account_info().try_borrow_mut_lamports()? -= refund_amount;
            **ctx.accounts.user.try_borrow_mut_lamports()? += refund_amount;
        }

        emit!(BetRefunded {
            market: market.key(),
            market_id,
            user: ctx.accounts.user.key(),
            amount: refund_amount,
        });

        Ok(())
    }

    /// Admin force-cancel a market and refund all bets
    pub fn admin_cancel_market(ctx: Context<AdminCancelMarket>, _market_id: u64) -> Result<()> {
        let market = &mut ctx.accounts.market;

        // Validations (admin check is in account constraint)
        require!(market.status != MarketStatus::Settled as u8, ErrorCode::MarketAlreadySettled);

        market.status = MarketStatus::Cancelled as u8;

        emit!(MarketCancelled {
            market: market.key(),
            market_id: market.id,
            admin: ctx.accounts.admin.key(),
        });

        Ok(())
    }

    /// Claim refund from a cancelled market
    pub fn claim_cancelled_refund(ctx: Context<ClaimCancelledRefund>, market_id: u64) -> Result<()> {
        let market = &mut ctx.accounts.market;
        let user_bet = &mut ctx.accounts.user_bet;

        require!(market.status == MarketStatus::Cancelled as u8, ErrorCode::MarketNotCancelled);
        require!(!user_bet.claimed, ErrorCode::AlreadyClaimed);

        let refund_amount = user_bet.amount;

        // CEI Pattern: Update state BEFORE transfers
        user_bet.claimed = true;

        if refund_amount > 0 {
            let market_balance = market.to_account_info().lamports();
            require!(market_balance >= refund_amount, ErrorCode::InsufficientFunds);
            **market.to_account_info().try_borrow_mut_lamports()? -= refund_amount;
            **ctx.accounts.user.try_borrow_mut_lamports()? += refund_amount;
        }

        emit!(BetRefunded {
            market: market.key(),
            market_id,
            user: ctx.accounts.user.key(),
            amount: refund_amount,
        });

        Ok(())
    }
}

// ============================================================================
// Account Structures
// ============================================================================

/// Minimum stake amount (0.001 SOL) to prevent dust attacks
pub const MIN_STAKE_AMOUNT: u64 = 1_000_000;

#[account]
pub struct Config {
    pub admin: Pubkey,
    pub fee_vault: Pubkey,
    pub create_fee: u64,
    pub join_fee_bps: u16,        // Fee for joining/betting (basis points)
    pub clearing_fee_bps: u16,    // Fee for claiming prize (basis points)
    pub settle_fee_bps: u16,      // Fee for settlement (basis points)
    pub next_market_id: u64,
}

#[account]
pub struct Market {
    pub id: u64,
    pub creator: Pubkey,
    pub question: String,
    pub options_count: u8,
    pub options: [String; MAX_OPTIONS],
    pub option_totals: [u64; MAX_OPTIONS],
    pub option_participants: [u32; MAX_OPTIONS],
    pub stake_amount: u64,
    pub bet_deadline: i64,
    pub resolve_time: i64,
    pub challenge_window: u64,
    pub status: u8,
    pub proposed_outcome: Option<u8>,
    pub proposer: Option<Pubkey>,
    pub challenge_end_time: Option<i64>,
    pub final_outcome: Option<u8>,
    pub created_at: i64,
    pub total_pool: u64,
}

#[account]
pub struct UserBet {
    pub market_id: u64,
    pub user: Pubkey,
    pub option_index: u8,
    pub amount: u64,
    pub claimed: bool,
    pub bet_count: u32,
}

#[derive(Clone, Copy, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
#[repr(u8)]
pub enum MarketStatus {
    Open = 0,
    Closed = 1,
    Proposed = 2,
    Disputed = 3,
    Settled = 4,
    Cancelled = 5,
}

// ============================================================================
// Account Contexts
// ============================================================================

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + 32 + 32 + 8 + 2 + 2 + 2 + 8, // discriminator + admin + fee_vault + create_fee + 3 fee_bps + next_market_id
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(mut, seeds = [b"config"], bump, has_one = admin @ ErrorCode::NotAdmin)]
    pub config: Account<'info, Config>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct SetAdmin<'info> {
    #[account(mut, seeds = [b"config"], bump, has_one = admin @ ErrorCode::NotAdmin)]
    pub config: Account<'info, Config>,
    pub admin: Signer<'info>,
}

// Calculate Market account space:
// 8 (discriminator) + 8 (id) + 32 (creator) + 4+256 (question string) + 1 (options_count)
// + 10*(4+64) (options array) + 10*8 (option_totals) + 10*4 (option_participants)
// + 8 (stake_amount) + 8 (bet_deadline) + 8 (resolve_time) + 8 (challenge_window)
// + 1 (status) + 2 (proposed_outcome Option) + 33 (proposer Option<Pubkey>)
// + 9 (challenge_end_time Option) + 2 (final_outcome Option) + 8 (created_at) + 8 (total_pool)
// = 8 + 8 + 32 + 260 + 1 + 680 + 80 + 40 + 8 + 8 + 8 + 8 + 1 + 2 + 33 + 9 + 2 + 8 + 8 = 1196
// Add some buffer: 1300

#[derive(Accounts)]
pub struct CreateMarket<'info> {
    #[account(
        init,
        payer = creator,
        space = 1500, // Generous space for market data
        seeds = [b"market", config.next_market_id.to_le_bytes().as_ref()],
        bump
    )]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub creator: Signer<'info>,
    /// CHECK: Validated through constraint
    #[account(
        mut,
        constraint = fee_vault.key() == config.fee_vault @ ErrorCode::InvalidFeeVault
    )]
    pub fee_vault: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct PlaceBet<'info> {
    #[account(
        mut,
        seeds = [b"market", market_id.to_le_bytes().as_ref()],
        bump,
        constraint = market.id == market_id @ ErrorCode::InvalidMarketId
    )]
    pub market: Account<'info, Market>,
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + 8 + 32 + 1 + 8 + 1 + 4,
        seeds = [b"user_bet", market_id.to_le_bytes().as_ref(), user.key().as_ref()],
        bump
    )]
    pub user_bet: Account<'info, UserBet>,
    #[account(seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub user: Signer<'info>,
    /// CHECK: Validated through constraint
    #[account(
        mut,
        constraint = fee_vault.key() == config.fee_vault @ ErrorCode::InvalidFeeVault
    )]
    pub fee_vault: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct InitiateSettlement<'info> {
    #[account(
        mut,
        seeds = [b"market", market_id.to_le_bytes().as_ref()],
        bump,
        constraint = market.id == market_id @ ErrorCode::InvalidMarketId
    )]
    pub market: Account<'info, Market>,
    #[account(
        seeds = [b"user_bet", market_id.to_le_bytes().as_ref(), proposer.key().as_ref()],
        bump,
        constraint = user_bet.user == proposer.key() @ ErrorCode::InvalidBetOwner,
        constraint = user_bet.market_id == market_id @ ErrorCode::InvalidMarketId
    )]
    pub user_bet: Account<'info, UserBet>,
    pub proposer: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct ChallengeSettlement<'info> {
    #[account(
        mut,
        seeds = [b"market", market_id.to_le_bytes().as_ref()],
        bump,
        constraint = market.id == market_id @ ErrorCode::InvalidMarketId
    )]
    pub market: Account<'info, Market>,
    /// Challenger must be a bettor in this market
    #[account(
        seeds = [b"user_bet", market_id.to_le_bytes().as_ref(), challenger.key().as_ref()],
        bump,
        constraint = challenger_bet.user == challenger.key() @ ErrorCode::InvalidBetOwner,
        constraint = challenger_bet.market_id == market_id @ ErrorCode::InvalidMarketId,
        constraint = challenger_bet.amount > 0 @ ErrorCode::MustBeBettor
    )]
    pub challenger_bet: Account<'info, UserBet>,
    pub challenger: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct FinalizeSettlement<'info> {
    #[account(
        mut,
        seeds = [b"market", market_id.to_le_bytes().as_ref()],
        bump,
        constraint = market.id == market_id @ ErrorCode::InvalidMarketId
    )]
    pub market: Account<'info, Market>,
    #[account(
        seeds = [b"user_bet", market_id.to_le_bytes().as_ref(), caller.key().as_ref()],
        bump,
        constraint = user_bet.user == caller.key() @ ErrorCode::InvalidBetOwner,
        constraint = user_bet.market_id == market_id @ ErrorCode::InvalidMarketId
    )]
    pub user_bet: Account<'info, UserBet>,
    pub caller: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct ResolveDispute<'info> {
    #[account(
        mut,
        seeds = [b"market", market_id.to_le_bytes().as_ref()],
        bump,
        constraint = market.id == market_id @ ErrorCode::InvalidMarketId
    )]
    pub market: Account<'info, Market>,
    #[account(seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(constraint = admin.key() == config.admin @ ErrorCode::NotAdmin)]
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct ClaimPrize<'info> {
    #[account(
        mut,
        seeds = [b"market", market_id.to_le_bytes().as_ref()],
        bump,
        constraint = market.id == market_id @ ErrorCode::InvalidMarketId
    )]
    pub market: Account<'info, Market>,
    #[account(
        mut,
        seeds = [b"user_bet", market_id.to_le_bytes().as_ref(), user.key().as_ref()],
        bump,
        constraint = user_bet.user == user.key() @ ErrorCode::InvalidBetOwner,
        constraint = user_bet.market_id == market_id @ ErrorCode::InvalidMarketId
    )]
    pub user_bet: Account<'info, UserBet>,
    #[account(seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub user: Signer<'info>,
    /// CHECK: Validated through constraint
    #[account(
        mut,
        constraint = fee_vault.key() == config.fee_vault @ ErrorCode::InvalidFeeVault
    )]
    pub fee_vault: AccountInfo<'info>,
}

#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct RefundBet<'info> {
    #[account(
        mut,
        seeds = [b"market", market_id.to_le_bytes().as_ref()],
        bump,
        constraint = market.id == market_id @ ErrorCode::InvalidMarketId
    )]
    pub market: Account<'info, Market>,
    #[account(
        mut,
        seeds = [b"user_bet", market_id.to_le_bytes().as_ref(), user.key().as_ref()],
        bump,
        constraint = user_bet.user == user.key() @ ErrorCode::InvalidBetOwner,
        constraint = user_bet.market_id == market_id @ ErrorCode::InvalidMarketId
    )]
    pub user_bet: Account<'info, UserBet>,
    #[account(mut)]
    pub user: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct AdminCancelMarket<'info> {
    #[account(
        mut,
        seeds = [b"market", market_id.to_le_bytes().as_ref()],
        bump,
        constraint = market.id == market_id @ ErrorCode::InvalidMarketId
    )]
    pub market: Account<'info, Market>,
    #[account(seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(constraint = admin.key() == config.admin @ ErrorCode::NotAdmin)]
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct ClaimCancelledRefund<'info> {
    #[account(
        mut,
        seeds = [b"market", market_id.to_le_bytes().as_ref()],
        bump,
        constraint = market.id == market_id @ ErrorCode::InvalidMarketId
    )]
    pub market: Account<'info, Market>,
    #[account(
        mut,
        seeds = [b"user_bet", market_id.to_le_bytes().as_ref(), user.key().as_ref()],
        bump,
        constraint = user_bet.user == user.key() @ ErrorCode::InvalidBetOwner,
        constraint = user_bet.market_id == market_id @ ErrorCode::InvalidMarketId
    )]
    pub user_bet: Account<'info, UserBet>,
    #[account(mut)]
    pub user: Signer<'info>,
}

// ============================================================================
// Events
// ============================================================================

#[event]
pub struct MarketCreated {
    pub market: Pubkey,
    pub market_id: u64,
    pub creator: Pubkey,
    pub question: String,
    pub options_count: u8,
    pub stake_amount: u64,
    pub bet_deadline: i64,
    pub resolve_time: i64,
    pub challenge_window: u64,
}

#[event]
pub struct BetPlaced {
    pub market: Pubkey,
    pub market_id: u64,
    pub user: Pubkey,
    pub option_index: u8,
    pub amount: u64,
    pub total_user_amount: u64,
}

#[event]
pub struct SettlementProposed {
    pub market: Pubkey,
    pub market_id: u64,
    pub proposer: Pubkey,
    pub proposed_outcome: u8,
    pub challenge_end_time: i64,
}

#[event]
pub struct SettlementChallenged {
    pub market: Pubkey,
    pub market_id: u64,
    pub challenger: Pubkey,
}

#[event]
pub struct MarketSettled {
    pub market: Pubkey,
    pub market_id: u64,
    pub outcome: u8,
    pub settled_by: Pubkey,
    pub is_admin_resolution: bool,
}

#[event]
pub struct PrizeClaimed {
    pub market: Pubkey,
    pub market_id: u64,
    pub user: Pubkey,
    pub amount: u64,
    pub fee: u64,
}

#[event]
pub struct BetRefunded {
    pub market: Pubkey,
    pub market_id: u64,
    pub user: Pubkey,
    pub amount: u64,
}

#[event]
pub struct MarketCancelled {
    pub market: Pubkey,
    pub market_id: u64,
    pub admin: Pubkey,
}

#[event]
pub struct AdminChanged {
    pub old_admin: Pubkey,
    pub new_admin: Pubkey,
}

// ============================================================================
// Error Codes
// ============================================================================

#[error_code]
pub enum ErrorCode {
    #[msg("Not admin")]
    NotAdmin,
    #[msg("Question too long")]
    QuestionTooLong,
    #[msg("Option label too long")]
    OptionTooLong,
    #[msg("Invalid options count (must be 2-10)")]
    InvalidOptionsCount,
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("Invalid bet deadline")]
    InvalidBetDeadline,
    #[msg("Invalid resolve time")]
    InvalidResolveTime,
    #[msg("Invalid challenge window")]
    InvalidChallengeWindow,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Invalid market ID")]
    InvalidMarketId,
    #[msg("Market is not open")]
    MarketNotOpen,
    #[msg("Betting period has closed")]
    BettingClosed,
    #[msg("Invalid option index")]
    InvalidOptionIndex,
    #[msg("Cannot change option after first bet")]
    CannotChangeOption,
    #[msg("Invalid market status")]
    InvalidMarketStatus,
    #[msg("Must be a bettor to perform this action")]
    MustBeBettor,
    #[msg("Market is not in proposed status")]
    MarketNotProposed,
    #[msg("No challenge window set")]
    NoChallengeWindow,
    #[msg("Challenge window has closed")]
    ChallengeWindowClosed,
    #[msg("Challenge window has not ended")]
    ChallengeWindowNotEnded,
    #[msg("Market is not in disputed status")]
    MarketNotDisputed,
    #[msg("Market is not settled")]
    MarketNotSettled,
    #[msg("No outcome determined")]
    NoOutcome,
    #[msg("Already claimed")]
    AlreadyClaimed,
    #[msg("Not a winner")]
    NotWinner,
    #[msg("No winners in this market")]
    NoWinners,
    #[msg("Insufficient funds")]
    InsufficientFunds,
    #[msg("Refund not available")]
    RefundNotAvailable,
    #[msg("Market already settled")]
    MarketAlreadySettled,
    #[msg("Market is not cancelled")]
    MarketNotCancelled,
    #[msg("Invalid fee vault")]
    InvalidFeeVault,
    #[msg("Invalid bet owner")]
    InvalidBetOwner,
    #[msg("Stake amount too small (minimum 0.001 SOL)")]
    StakeTooSmall,
    #[msg("Invalid admin address")]
    InvalidAdmin,
}
