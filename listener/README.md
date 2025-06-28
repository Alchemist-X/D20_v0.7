## How to adapt it into the backend

In the `handlePoolCreated` function of `listener/listener.ts`, we can process the newly fetched pool information, and write into the backend database accordingly.


## Usage

In the root project directory (not this directory), run `yarn listen` to listen the latest pool change. 

You can also run `yarn listen:historical` to parse the history pools.