/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/d20_binary_options.json`.
 */
export type D20BinaryOptions = {
  "address": "9L4vos4SJyyKtgiVjKsPQxPKbtwYsMuCcbcrkxaLsaQj",
  "metadata": {
    "name": "d20BinaryOptions",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Created with Anchor"
  },
  "instructions": [
    {
      "name": "claimPrize",
      "discriminator": [
        157,
        233,
        139,
        121,
        246,
        62,
        234,
        235
      ],
      "accounts": [
        {
          "name": "pool",
          "writable": true
        },
        {
          "name": "winner",
          "writable": true,
          "signer": true
        }
      ],
      "args": []
    },
    {
      "name": "createPool",
      "discriminator": [
        233,
        146,
        209,
        142,
        207,
        104,
        64,
        188
      ],
      "accounts": [
        {
          "name": "pool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "creator"
              }
            ]
          }
        },
        {
          "name": "creator",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "memeToken",
          "type": "pubkey"
        },
        {
          "name": "targetPrice",
          "type": "u64"
        },
        {
          "name": "currentPrice",
          "type": "u64"
        },
        {
          "name": "expiry",
          "type": "i64"
        },
        {
          "name": "amount",
          "type": "u64"
        },
        {
          "name": "side",
          "type": "u8"
        }
      ]
    },
    {
      "name": "initialize",
      "discriminator": [
        175,
        175,
        109,
        31,
        13,
        152,
        155,
        237
      ],
      "accounts": [],
      "args": []
    },
    {
      "name": "joinPool",
      "discriminator": [
        14,
        65,
        62,
        16,
        116,
        17,
        195,
        107
      ],
      "accounts": [
        {
          "name": "pool",
          "writable": true
        },
        {
          "name": "opponent",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "settlePool",
      "discriminator": [
        186,
        11,
        231,
        111,
        242,
        241,
        203,
        64
      ],
      "accounts": [
        {
          "name": "pool",
          "writable": true
        },
        {
          "name": "creator",
          "writable": true
        },
        {
          "name": "opponent",
          "writable": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "finalPrice",
          "type": "u64"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "gamblingPool",
      "discriminator": [
        23,
        120,
        245,
        59,
        196,
        255,
        145,
        213
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "invalidExpiry",
      "msg": "Invalid expiry time"
    },
    {
      "code": 6001,
      "name": "invalidAmount",
      "msg": "Invalid amount"
    },
    {
      "code": 6002,
      "name": "invalidSide",
      "msg": "Invalid side"
    },
    {
      "code": 6003,
      "name": "poolNotActive",
      "msg": "Pool is not active"
    },
    {
      "code": 6004,
      "name": "poolExpired",
      "msg": "Pool has expired"
    },
    {
      "code": 6005,
      "name": "poolNotExpired",
      "msg": "Pool is not expired yet"
    },
    {
      "code": 6006,
      "name": "poolAlreadyJoined",
      "msg": "Pool already has an opponent"
    },
    {
      "code": 6007,
      "name": "poolNotJoined",
      "msg": "Pool has no opponent yet"
    },
    {
      "code": 6008,
      "name": "invalidPrice",
      "msg": "Invalid price from oracle"
    },
    {
      "code": 6009,
      "name": "poolNotSettled",
      "msg": "Pool is not settled yet"
    },
    {
      "code": 6010,
      "name": "noWinner",
      "msg": "No winner determined"
    },
    {
      "code": 6011,
      "name": "notWinner",
      "msg": "Not the winner"
    }
  ],
  "types": [
    {
      "name": "gamblingPool",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "memeToken",
            "type": "pubkey"
          },
          {
            "name": "targetPrice",
            "type": "u64"
          },
          {
            "name": "expiry",
            "type": "i64"
          },
          {
            "name": "creator",
            "type": "pubkey"
          },
          {
            "name": "creatorAmount",
            "type": "u64"
          },
          {
            "name": "creatorSide",
            "type": "u8"
          },
          {
            "name": "opponentAmount",
            "type": "u64"
          },
          {
            "name": "status",
            "type": "u8"
          },
          {
            "name": "winner",
            "type": {
              "option": "pubkey"
            }
          }
        ]
      }
    }
  ]
};
