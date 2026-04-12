#!/bin/bash

# Wait for MongoDB to start
sleep 5

# Only initiate the replica set if not already configured
mongosh --host mongodb1:27017 \
        --username root \
        --password example \
        --authenticationDatabase admin \
        --eval '
          try {
            const status = rs.status();
            print("Replica set already initialized, skipping.");
          } catch (e) {
            rs.initiate({_id: "rs0", members: [ {_id: 0, host: "mongodb1:27017", priority: 2}, {_id: 1, host: "mongodb2:27017", priority: 1} ]});
          }
        '
