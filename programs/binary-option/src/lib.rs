use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::rent::Rent;

declare_id!("HC2L1MCeKvd9EgvjrahyGRk3FbZwBnUUz3L4BHYHKf8i");

#[program]
pub mod d20_binary_options {
    use super::*;

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
        config.join_fee_bps = join_fee_bps; // rate is join_fee_bps * 1/10000 of the amount
        config.clearing_fee_bps = clearing_fee_bps;
        config.settle_fee_bps = settle_fee_bps;
        config.oracle = ctx.accounts.oracle.key();
        config.next_pool_id = 1; // Start pool IDs from 1
        
        msg!("Binary Options Config initialized");
        Ok(())
    }

    pub fn create_pool(
        ctx: Context<CreatePool>,
        meme_token: Pubkey,
        target_price: u64,
        expiry: i64,
        amount: u64,
        side: u8, // 0: call (higher), 1: put (lower)
    ) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        let config = &mut ctx.accounts.config;
        let clock = Clock::get()?;

        // Get the current pool ID and increment for next use
        let pool_id = config.next_pool_id;
        config.next_pool_id = config.next_pool_id.checked_add(1).ok_or(ErrorCode::Overflow)?;

        // Validations
        require!(expiry > clock.unix_timestamp + 5, ErrorCode::InvalidExpiry); // Must be at least 5 seconds from now (for testing)
        require!(amount > 0, ErrorCode::InvalidAmount);
        require!(side <= 1, ErrorCode::InvalidSide);
        require!(target_price > 0, ErrorCode::InvalidPrice);
        require!(expiry <= clock.unix_timestamp + 7 * 24 * 3600, ErrorCode::ExpiryTooFar); // Max 7 days
        require!(amount >= 10_000_000, ErrorCode::AmountTooSmall); // Min 0.01 SOL

        // Calculate fees
        let create_fee = config.create_fee;

        // Transfer SOL including fees
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

        // Transfer create fee to fee vault
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

        // Initialize pool
        pool.id = pool_id;
        pool.meme_token = meme_token;
        pool.target_price = target_price;
        pool.expiry = expiry;
        pool.creator = ctx.accounts.creator.key();
        pool.call_total_amount = if side == 0 { amount } else { 0 };
        pool.put_total_amount = if side == 1 { amount } else { 0 };
        pool.call_participants = if side == 0 { 1 } else { 0 };
        pool.put_participants = if side == 1 { 1 } else { 0 };
        pool.status = PoolStatus::Active as u8;
        pool.winning_side = None;
        pool.created_at = clock.unix_timestamp;
        pool.settled_price = None;

        // Initialize creator's bet
        let user_bet = &mut ctx.accounts.user_bet;
        user_bet.pool_id = pool_id;
        user_bet.user = ctx.accounts.creator.key();
        user_bet.amount = amount;
        user_bet.side = side;
        user_bet.claimed = false;

        emit!(PoolCreated {
            pool: pool.key(),
            creator: pool.creator,
            meme_token: pool.meme_token,
            target_price: pool.target_price,
            amount,
            side,
            expiry: pool.expiry,
        });

        Ok(())
    }

    pub fn join_pool(
        ctx: Context<JoinPool>,
        pool_id: u64,
        amount: u64,
        side: u8, // 0: call, 1: put
    ) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        let config = &ctx.accounts.config;
        let clock = Clock::get()?;

        // Validations
        require!(pool.status == PoolStatus::Active as u8, ErrorCode::PoolNotActive);
        require!(clock.unix_timestamp < pool.expiry, ErrorCode::PoolExpired);
        require!(side <= 1, ErrorCode::InvalidSide);
        require!(amount >= 100_000_000, ErrorCode::AmountTooSmall); // Min 0.1 SOL
        require!(pool.id == pool_id, ErrorCode::InvalidPoolId);

        // Calculate join fee
        let join_fee = amount
            .checked_mul(config.join_fee_bps as u64)
            .ok_or(ErrorCode::Overflow)?
            .checked_div(10000)
            .ok_or(ErrorCode::Overflow)?;

        // Transfer stake amount to pool
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.user.to_account_info(),
                    to: pool.to_account_info(),
                },
            ),
            amount,
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

        // Update pool totals and participant counts
        if side == 0 {
            pool.call_total_amount = pool.call_total_amount.checked_add(amount).ok_or(ErrorCode::Overflow)?;
            pool.call_participants = pool.call_participants.checked_add(1).ok_or(ErrorCode::Overflow)?;
        } else {
            pool.put_total_amount = pool.put_total_amount.checked_add(amount).ok_or(ErrorCode::Overflow)?;
            pool.put_participants = pool.put_participants.checked_add(1).ok_or(ErrorCode::Overflow)?;
        }

        // Initialize user's bet
        let user_bet = &mut ctx.accounts.user_bet;
        user_bet.pool_id = pool_id;
        user_bet.user = ctx.accounts.user.key();
        user_bet.amount = amount;
        user_bet.side = side;
        user_bet.claimed = false;

        emit!(PoolJoined {
            pool: pool.key(),
            user: ctx.accounts.user.key(),
            amount,
            side,
        });

        Ok(())
    }

    pub fn settle_pool(
        ctx: Context<SettlePool>,
        final_price: u64,
    ) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        let config = &ctx.accounts.config;
        let clock = Clock::get()?;

        // Only oracle can settle pools
        require!(ctx.accounts.oracle.key() == config.oracle, ErrorCode::UnauthorizedOracle);
        require!(pool.status == PoolStatus::Active as u8, ErrorCode::PoolNotActive);
        require!(clock.unix_timestamp >= pool.expiry, ErrorCode::PoolNotExpired);
        require!(pool.call_total_amount > 0 || pool.put_total_amount > 0, ErrorCode::NoParticipants);
        require!(final_price > 0, ErrorCode::InvalidPrice);

        // Calculate total prize pool for settle fee
        let total_staked = pool.call_total_amount.checked_add(pool.put_total_amount).ok_or(ErrorCode::Overflow)?;
        
        // Calculate settle fee
        let settle_fee = total_staked
            .checked_mul(config.settle_fee_bps as u64)
            .ok_or(ErrorCode::Overflow)?
            .checked_div(10000)
            .ok_or(ErrorCode::Overflow)?;
        
        // Transfer settle fee to fee vault
        if settle_fee > 0 {
            let pool_balance = pool.to_account_info().lamports();
            require!(pool_balance >= settle_fee, ErrorCode::InsufficientFunds);
            **pool.to_account_info().try_borrow_mut_lamports()? -= settle_fee;
            **ctx.accounts.fee_vault.try_borrow_mut_lamports()? += settle_fee;
        }
        
        // Determine winning side
        let call_wins = final_price > pool.target_price;
        
        // Set winning side
        pool.winning_side = if call_wins {
            Some(0) // CALL side wins
        } else {
            Some(1) // PUT side wins
        };

        pool.status = PoolStatus::Settled as u8;
        pool.settled_price = Some(final_price);

        emit!(PoolSettled {
            pool: pool.key(),
            winning_side: pool.winning_side,
            final_price,
            call_wins,
        });

        Ok(())
    }

    pub fn claim_prize(ctx: Context<ClaimPrize>) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        let user_bet = &mut ctx.accounts.user_bet;
        let config = &ctx.accounts.config;
        
        require!(pool.status == PoolStatus::Settled as u8, ErrorCode::PoolNotSettled);
        require!(pool.winning_side.is_some(), ErrorCode::NoWinner);
        require!(user_bet.side == pool.winning_side.unwrap(), ErrorCode::NotWinner);

        // Calculate user's proportional winnings
        let winning_side_total = if pool.winning_side.unwrap() == 0 {
            pool.call_total_amount
        } else {
            pool.put_total_amount
        };
        
        require!(winning_side_total > 0, ErrorCode::NoWinner);
        
        // Calculate total prize pool (call_total + put_total)
        let total_staked = pool.call_total_amount.checked_add(pool.put_total_amount).ok_or(ErrorCode::Overflow)?;
        
        // Calculate settle fee that was already deducted during settlement
        let settle_fee = total_staked
            .checked_mul(config.settle_fee_bps as u64)
            .ok_or(ErrorCode::Overflow)?
            .checked_div(10000)
            .ok_or(ErrorCode::Overflow)?;
        
        // Available prize pool after settle fee deduction
        let available_prize_pool = total_staked.checked_sub(settle_fee).ok_or(ErrorCode::Overflow)?;
        
        // User's share = (user_bet_amount / winning_side_total) * available_prize_pool
        let user_share_before_fees = available_prize_pool
            .checked_mul(user_bet.amount)
            .ok_or(ErrorCode::Overflow)?
            .checked_div(winning_side_total)
            .ok_or(ErrorCode::Overflow)?;
        
        // Calculate clearing fee on user's share
        let clearing_fee = user_share_before_fees
            .checked_mul(config.clearing_fee_bps as u64)
            .ok_or(ErrorCode::Overflow)?
            .checked_div(10000)
            .ok_or(ErrorCode::Overflow)?;
        
        let user_payout = user_share_before_fees
            .checked_sub(clearing_fee)
            .ok_or(ErrorCode::Overflow)?;

        // Transfer clearing fee to fee vault
        if clearing_fee > 0 {
            let pool_balance = pool.to_account_info().lamports();
            require!(pool_balance >= clearing_fee, ErrorCode::InsufficientFunds);
            **pool.to_account_info().try_borrow_mut_lamports()? -= clearing_fee;
            **ctx.accounts.fee_vault.try_borrow_mut_lamports()? += clearing_fee;
        }

        // Transfer winnings to user
        if user_payout > 0 {
            let pool_balance = pool.to_account_info().lamports();
            require!(pool_balance >= user_payout, ErrorCode::InsufficientFunds);
            **pool.to_account_info().try_borrow_mut_lamports()? -= user_payout;
            **ctx.accounts.user.try_borrow_mut_lamports()? += user_payout;
        }

        // Mark bet as claimed
        user_bet.claimed = true;

        emit!(PrizeClaimed {
            pool: pool.key(),
            user: ctx.accounts.user.key(),
            amount: user_payout,
            fee: clearing_fee,
        });

        Ok(())
    }

    // NOTE: we currently do NOT allow cancelling pools
    // pub fn cancel_pool(ctx: Context<CancelPool>) -> Result<()> {
    //     let pool = &mut ctx.accounts.pool;

    //     require!(pool.status == PoolStatus::Active as u8, ErrorCode::PoolNotActive);
    //     require!(pool.opponent.is_none(), ErrorCode::PoolAlreadyJoined);
    //     require!(ctx.accounts.creator.key() == pool.creator, ErrorCode::NotCreator);

    //     // Refund creator's stake
    //     let pool_lamports = pool.to_account_info().lamports();
    //     let rent = Rent::get()?;
    //     let rent_exempt_balance = rent.minimum_balance(pool.to_account_info().data_len());
        
    //     if pool_lamports > rent_exempt_balance {
    //         let refund_amount = pool_lamports - rent_exempt_balance;
    //         **pool.to_account_info().try_borrow_mut_lamports()? -= refund_amount;
    //         **ctx.accounts.creator.try_borrow_mut_lamports()? += refund_amount;
    //     }

    //     pool.status = PoolStatus::Cancelled as u8;

    //     emit!(PoolCancelled {
    //         pool: pool.key(),
    //         creator: pool.creator,
    //     });

    //     Ok(())
    // }

    pub fn update_config(
        ctx: Context<UpdateConfig>,
        fee_vault: Pubkey,
        create_fee: u64,
        join_fee_bps: u16,
        clearing_fee_bps: u16,
        settle_fee_bps: u16,
        oracle: Pubkey,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        
        // Only admin can update config
        require!(ctx.accounts.admin.key() == config.admin, ErrorCode::NotAdmin);
        
        config.fee_vault = fee_vault;
        config.create_fee = create_fee;
        config.join_fee_bps = join_fee_bps;
        config.clearing_fee_bps = clearing_fee_bps;
        config.settle_fee_bps = settle_fee_bps;
        config.oracle = oracle;
        
        msg!("Binary Options Config updated");
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + 32 + 32 + 8 + 2 + 2 + 2 + 32 + 8,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub admin: Signer<'info>,
    /// CHECK: Oracle account for price feeds
    pub oracle: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct GamblingPool {
    pub id: u64,                     // Unique pool ID
    pub meme_token: Pubkey,          // Meme token contract address
    pub target_price: u64,           // Target price (in micro-units)
    pub expiry: i64,                // Expiry timestamp
    pub creator: Pubkey,            // Pool creator (first user)
    pub call_total_amount: u64,     // Total amount bet on CALL side
    pub put_total_amount: u64,      // Total amount bet on PUT side
    pub call_participants: u32,     // Number of CALL participants
    pub put_participants: u32,      // Number of PUT participants
    pub status: u8,                 // Pool status
    pub winning_side: Option<u8>,   // Winning side (0: call, 1: put, None: not settled)
    pub created_at: i64,            // Creation timestamp
    pub settled_price: Option<u64>, // Final settlement price
}

#[account]
pub struct UserBet {
    pub pool_id: u64,               // Which pool this bet belongs to
    pub user: Pubkey,               // User who made the bet
    pub amount: u64,                // Amount of SOL bet
    pub side: u8,                   // 0: call, 1: put
    pub claimed: bool,              // Whether user has claimed winnings
}

#[account]
pub struct Config {
    pub admin: Pubkey,
    pub fee_vault: Pubkey,
    pub create_fee: u64,       // Create pool fee in lamports
    pub join_fee_bps: u16,     // Join fee in basis points (e.g., 50 = 0.5%)
    pub clearing_fee_bps: u16, // Clearing fee in basis points (e.g., 100 = 1%)
    pub settle_fee_bps: u16,   // Settlement fee in basis points (e.g., 100 = 1%)
    pub oracle: Pubkey,        // Authorized oracle for price feeds
    pub next_pool_id: u64,     // Next incremental pool ID
}

#[derive(Accounts)]
pub struct CreatePool<'info> {
    #[account(
        init,
        payer = creator,
        space = 8 + 8 + 32 + 8 + 8 + 32 + 8 + 8 + 4 + 4 + 1 + 2 + 8 + 9,
        seeds = [b"pool", config.next_pool_id.to_le_bytes().as_ref()],
        bump
    )]
    pub pool: Account<'info, GamblingPool>,
    #[account(
        init,
        payer = creator,
        space = 8 + 8 + 32 + 8 + 1 + 1,
        seeds = [b"user_bet", config.next_pool_id.to_le_bytes().as_ref(), creator.key().as_ref()],
        bump
    )]
    pub user_bet: Account<'info, UserBet>,
    #[account(mut, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub creator: Signer<'info>,
    /// CHECK: Validated through constraint that matches config.fee_vault
    #[account(
        mut,
        constraint = fee_vault.key() == config.fee_vault @ ErrorCode::InvalidFeeVault
    )]
    pub fee_vault: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(pool_id: u64)]
pub struct JoinPool<'info> {
    #[account(mut)]
    pub pool: Account<'info, GamblingPool>,
    #[account(
        init,
        payer = user,
        space = 8 + 8 + 32 + 8 + 1 + 1,
        seeds = [b"user_bet", pool_id.to_le_bytes().as_ref(), user.key().as_ref()],
        bump
    )]
    pub user_bet: Account<'info, UserBet>,
    #[account(seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub user: Signer<'info>,
    /// CHECK: Validated through constraint that matches config.fee_vault
    #[account(
        mut,
        constraint = fee_vault.key() == config.fee_vault @ ErrorCode::InvalidFeeVault
    )]
    pub fee_vault: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettlePool<'info> {
    #[account(mut)]
    pub pool: Account<'info, GamblingPool>,
    #[account(seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    pub oracle: Signer<'info>,
    /// CHECK: Validated through constraint that matches config.fee_vault
    #[account(
        mut,
        constraint = fee_vault.key() == config.fee_vault @ ErrorCode::InvalidFeeVault
    )]
    pub fee_vault: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct ClaimPrize<'info> {
    #[account(mut)]
    pub pool: Account<'info, GamblingPool>,
    #[account(
        mut,
        constraint = user_bet.pool_id == pool.id @ ErrorCode::InvalidPoolId,
        constraint = !user_bet.claimed @ ErrorCode::AlreadyClaimed
    )]
    pub user_bet: Account<'info, UserBet>,
    #[account(seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub user: Signer<'info>,
    /// CHECK: Validated through constraint that matches config.fee_vault
    #[account(
        mut,
        constraint = fee_vault.key() == config.fee_vault @ ErrorCode::InvalidFeeVault
    )]
    pub fee_vault: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct CancelPool<'info> {
    #[account(mut)]
    pub pool: Account<'info, GamblingPool>,
    #[account(mut)]
    pub creator: Signer<'info>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(mut, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    pub admin: Signer<'info>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum PoolStatus {
    Active = 0,
    Settled = 1,
    Claimed = 2,
    Cancelled = 3,
}

#[event]
pub struct PoolCreated {
    pub pool: Pubkey,
    pub creator: Pubkey,
    pub meme_token: Pubkey,
    pub target_price: u64,
    pub amount: u64,
    pub side: u8,
    pub expiry: i64,
}

#[event]
pub struct PoolJoined {
    pub pool: Pubkey,
    pub user: Pubkey,
    pub amount: u64,
    pub side: u8,
}

#[event]
pub struct PoolSettled {
    pub pool: Pubkey,
    pub winning_side: Option<u8>,  // 0: call, 1: put
    pub final_price: u64,
    pub call_wins: bool,
}

#[event]
pub struct PrizeClaimed {
    pub pool: Pubkey,
    pub user: Pubkey,
    pub amount: u64,
    pub fee: u64,
}

#[event]
pub struct PoolCancelled {
    pub pool: Pubkey,
    pub creator: Pubkey,
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
    #[msg("Expiry too far in the future")]
    ExpiryTooFar,
    #[msg("Amount too small")]
    AmountTooSmall,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Cannot join your own pool")]
    CannotJoinOwnPool,
    #[msg("Unauthorized oracle")]
    UnauthorizedOracle,
    #[msg("Insufficient funds")]
    InsufficientFunds,
    #[msg("Not the pool creator")]
    NotCreator,
    #[msg("Not the admin")]
    NotAdmin,
    #[msg("Invalid pool ID")]
    InvalidPoolId,
    #[msg("No participants in pool")]
    NoParticipants,
    #[msg("Prize already claimed")]
    AlreadyClaimed,
    #[msg("Invalid fee vault")]
    InvalidFeeVault,
}
