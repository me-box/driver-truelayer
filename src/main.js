/*jshint esversion: 6 */

// Based on the official TrueLayer JS Client
// https://github.com/TrueLayer/truelayer-client-javascript

// General
const https = require('https');
const express = require("express");
const request = require("request");
const bodyParser = require("body-parser");

// TrueLayer
const {AuthAPIClient, DataAPIClient} = require("truelayer-client");
const TrueLayerDefaultSettings = require('./truelayer-secret.json');
const client = new AuthAPIClient(TrueLayerDefaultSettings);
const permission_scopes = ["info", "accounts", "balance", "transactions", "offline_access", "cards"];
const redirect_uri = "http://localhost:5000/truelayer-redirect";

// DataBox
const databox = require('node-databox');
const DATABOX_ZMQ_ENDPOINT = process.env.DATABOX_ZMQ_ENDPOINT;
const credentials = databox.getHttpsCredentials();

const PORT = process.env.port || '8080';
const app = express();

app.use(bodyParser.urlencoded({extended: true}));

let timer = setInterval(timer_callback, 1000 * 60);  // per minute
let next_token_refresh = null;
let next_data_refresh = null;

// Step 1: Auth with TrueLayer
app.get('/ui', function (req, res) {
    getSettings()
    .then((settings) => {
        const { redirect_uri } = settings;
        const authURL = client.getAuthUrl(redirect_uri, scopes, "foobar");

        // list them to the user
        res.type('html');
        // TODO: Use a pug template instead
        res.send(`
        <h1>TrueLayer Driver Authentication</h1>
        <form action="${authURL}">
            <button>Authorise</button>
        </form>
        `);
    });
});

// Step 2: Get token
app.get('/truelayer-redirect', (req, res) => {
    getSettings()
    .then((settings) => {
        const { client_id, client_secret, redirect_uri } = settings;
        const { code } = req.query.code;
        const tokens = await client.exchangeCodeForToken(redirect_uri, code);
        settings.tokens = tokens;

        setSettings(settings)
        .then(() => {
            res.redirect('/configure');
        });
    });
});

// Step 3: Configure Driver
// (i.e. choose the Account you want to monitor)
app.get('/configure', (req, res) => {
    getSettings()
    .then((settings) => {
        const { tokens } = settings;

        // get all accounts
        const accounts = await DataAPIClient.getAccounts(tokens.access_token);

        // list them to the user
        res.type('html');
        // TODO: Use a pug template instead
        res.write('<h1>TrueLayer Driver Configuration</h1>');
        res.write('<p>Please choose the account you want to monitor and its refresh interval:</p>');
        res.write('<form action="/saveConfiguration">');
        res.write('Accounts:<br>');

        for(let account of accounts) {
            const {account_id, account_type, display_name } = account;
            res.write(`
                <input type="radio" name="account" value="${account_id}"> ${display_name} (<i>${account_type}</i>)<br><br>
                `);
        }
        res.write('Refresh Interval (minutes): <input type="text" name="refresh_interval" value="30"><br><br>');
        res.write('<button>Save Configuration</button>');
        res.end('</form>');
    });
});

// Step 4: Parse response and save configuration
app.get('/saveConfiguration', function (req, res) {
    let newAccount = req.query.account;
    let newRefreshInterval = req.query.refresh_interval;
    console.log(newAccount);
    console.log(newRefreshInterval);

    getSettings()
    .then((settings) => {
        settings.account_id = newAccount;
        settings.refresh_interval = newRefreshInterval;
        console.log("[SETTINGS]", settings);
        return setSettings(settings);
    })
    .then((settings) => {
        // Start/Restart monitoring with new settings
        refresh_data();
    })
    .catch((error) => {
        console.log("[saveConfiguration] Error ", error);
        res.status(400).send({statusCode: 400, body: "error saving configuration settings."});
    });
});

app.get("/status", function (req, res) {
    res.send("active");
});

console.log("[Creating server]");
https.createServer(credentials, app).listen(PORT);
module.exports = app;

let tsc = databox.NewTimeSeriesBlobClient(DATABOX_ZMQ_ENDPOINT, false);
let kvc = databox.NewKeyValueClient(DATABOX_ZMQ_ENDPOINT, false);

let balance = databox.NewDataSourceMetadata();
balance.Description = 'TrueLayer user Balance data';
balance.ContentType = 'application/json';
balance.Vendor = 'Databox Inc.';
balance.DataSourceType = 'truelayerUserBalance';
balance.DataSourceID = 'truelayerUserBalance';
balance.StoreType = 'ts';

let transactions = databox.NewDataSourceMetadata();
transactions.Description = 'TrueLayer user Transactions data';
transactions.ContentType = 'application/json';
transactions.Vendor = 'Databox Inc.';
transactions.DataSourceType = 'truelayerUserTransactions';
transactions.DataSourceID = 'truelayerUserTransactions';
transactions.StoreType = 'ts';

let driverSettings = databox.NewDataSourceMetadata();
driverSettings.Description = 'TrueLayer driver settings';
driverSettings.ContentType = 'application/json';
driverSettings.Vendor = 'Databox Inc.';
driverSettings.DataSourceType = 'truelayerSettings';
driverSettings.DataSourceID = 'truelayerSettings';
driverSettings.StoreType = 'kv';

tsc.RegisterDatasource(balance)
    .then(() => {
        return tsc.RegisterDatasource(transactions);
    })
    .then(() => {
        return kvc.RegisterDatasource(driverSettings);
    })
    .catch((err) => {
        console.log("Error registering data source:" + err);
    });

function getSettings() {
    datasourceid = 'truelayerSettings';
    return new Promise((resolve, reject) => {
        kvc.Read(datasourceid, "settings")
        .then((settings) => {
            console.log("[getSettings] read response = ", settings);
            if (Object.keys(settings).length === 0) {
                //return defaults
                let settings = TrueLayerDefaultSettings;
                settings.redirect_uri = redirect_uri;
                console.log("[getSettings] using defaults Using ----> ", settings);
                resolve(settings);
                return;
            }
            console.log("[getSettings]", settings);
            resolve(settings);
        })
        .catch((err) => {
            let settings = TrueLayerDefaultSettings;
            settings.redirect_uri = redirect_uri;
            console.log("[getSettings] using defaults Using ----> ", settings);
            resolve(settings);
        });
    });
}

function setSettings(settings) {
    let datasourceid = 'truelayerSettings';
    return new Promise((resolve, reject) => {
        kvc.Write(datasourceid, "settings", settings)
        .then(() => {
            console.log('[setSettings] settings saved', settings);
            resolve(settings);
        })
        .catch((err) => {
            console.log("Error setting settings", err);
            reject(err);
        });
    });
}

function save(datasourceid, data) {
    console.log("Saving TrueLayer event::", data.text);
    json = {"data": data};
    tsc.Write(datasourceid, data)
    .then((resp) => {
        console.log("Save got response ", resp);
    })
    .catch((error) => {
        console.log("Error writing to store:", error);
    });
}

// Should be called periodically to refresh the token before it expires
function refresh_token() {
    getSettings()
    .then((settings) => {
        const { tokens } = settings;

        await client.refresh_token(tokens);
    });
}

function timer_callback() {

    getSettings()
    .then((settings) => {
        const {refresh_interval, tokens} = settings;

        // current datetime
        var now = newDate();

        if (next_token_refresh == null ||
            next_token_refresh < now) {

            refresh_token(tokens);

            // plan next refresh
            next_token_refresh = Date().setMinutes(now.getMinutes() + 30); // 30 mins
        }

        if (next_data_refresh == null ||
            next_data_refresh < now) {
            refresh_balance();
            refresh_transactions();

            // plan next refresh
            next_data_refresh = Date().setMinutes(now.getMinutes() + refresh_interval);
        }
    });
}

function refresh_balance() {
    getSettings()
    .then((settings) => {
        const { tokens } = settings;

        const balance = await DataAPIClient.getBalance(tokens.access_token);
        save('truelayerUserBalance', balance);
    });
}

function refresh_transactions() {
    getSettings()
    .then((settings) => {
        const { tokens } = settings;

        const transactions = await DataAPIClient.getTransactions(tokens.access_token);
        save('truelayerUserTransactions', transactions);
    });
}
