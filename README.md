# driver-truelayer
A [DataBox](https://www.databoxproject.uk) driver to stream financial data from [TrueLayer](https://truelayer.com). TrueLayer supports a series of UK banks (soon to be expanded to more countries). At the moment it has only been tested with [Monzo bank](http://monzo.com).


# Status
This is work in progress but getting better ;-).

# Authentication
If you wish to use this driver with your own TrueLayer account then:

- Sign up in https://truelayer.com and log in.
- Create a new app and set the redirect_url to https://127.0.0.1/driver-truelayer/ui/truelayer-redirect.
- Copy and paste `client_id`, `client_secret` and `redirect_url` into the driver and click Authenticate with TrueLayer.
- In the driver settings, choose the bank account you wish to monitor and the Refresh Interval (in minutes).


# Data stored
This driver writes transactional event data into a store-json for later processing.

It saves the following streams of data:

1. `truelayerUserBalance`: the balance on every refresh update (30 minutes by default)
2. `truelayerUserTransactions`: detailed transactions of the monitored account.

These can then be accessed store-json API.


## Databox is funded by the following grants:

```
EP/N028260/1, Databox: Privacy-Aware Infrastructure for Managing Personal Data

EP/N028260/2, Databox: Privacy-Aware Infrastructure for Managing Personal Data

EP/N014243/1, Future Everyday Interaction with the Autonomous Internet of Things

EP/M001636/1, Privacy-by-Design: Building Accountability into the Internet of Things (IoTDatabox)

EP/M02315X/1, From Human Data to Personal Experience

```
