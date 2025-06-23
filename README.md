# D20

Binary Option on Solana - Customized Betting Protocol

## Setup

```shell
# build the program
anchor build 

# run the tests
anchor test
```


## Remaining Issues

1. When there's no opposite users, we should allow refund.
2. Due to the integer truncated, there probably exists dusts in the pool, the admin should be able to withdraw it.