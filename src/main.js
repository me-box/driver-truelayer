// Based on the official TrueLayer JS Client
// https://github.com/TrueLayer/truelayer-client-javascript

// General
const https = require('https');
const http = require('http');
const express = require('express');
//const request = require('request');
const bodyParser = require('body-parser');
const nonce = require('nonce-generator');
const fs = require('fs');

// TrueLayer
const { AuthAPIClient, DataAPIClient } = require('truelayer-client');
let TrueLayerDefaultSettings = {};
try {
  TrueLayerDefaultSettings = require('./truelayer-secret.json');
} catch (e) {
  TrueLayerDefaultSettings = {
    'client_id': '',
    'client_secret': '',
    'redirect_url': 'https://127.0.0.1/driver-truelayer/ui/truelayer-redirect',
  };
}
const permission_scopes = ['accounts', 'balance', 'transactions', 'offline_access'];
let client;

// DataBox
const databox = require('node-databox');
const DATABOX_ARBITER_ENDPOINT = process.env.DATABOX_ARBITER_ENDPOINT || 'tcp://127.0.0.1:4444';
const DATABOX_ZMQ_ENDPOINT = process.env.DATABOX_ZMQ_ENDPOINT || 'tcp://127.0.0.1:5555';
const DATABOX_TESTING = !(process.env.DATABOX_VERSION);

const PORT = process.env.port || '8080';
const store = databox.NewStoreClient(DATABOX_ZMQ_ENDPOINT, DATABOX_ARBITER_ENDPOINT);

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));

const token_refresh_interval = 30;  // in minutes
const timer = setInterval(timer_callback, 1000 * 60);  // per minute
let next_data_refresh = null;

// Load page templates
const ui_template = fs.readFileSync('src/views/ui.html', 'utf8');
const authenticate_template = fs.readFileSync('src/views/authenticate.html', 'utf8');
const configure_template = fs.readFileSync('src/views/configure.html', 'utf8');
const saveConfiguration_template = fs.readFileSync('src/views/saveConfiguration.html', 'utf8');


// Step 1: Auth with TrueLayer
app.get('/ui', function (req, res) {
  getSettings()
    .then((settings) => {
      const { client_id, client_secret, redirect_url } = settings;
      res.type('html');
      const html = ui_template
        .replace('__CLIENT_ID__', client_id)
        .replace('__CLIENT_SECRET__', client_secret)
        .replace('__REDIRECT_URL__', redirect_url);
      res.send(html);
    });
});

// Step 2: Auth with TrueLayer
app.get('/ui/authenticate', function (req, res) {
  getSettings()
    .then((settings) => {
      const { client_id, client_secret, redirect_url } = req.query;

      // save into settings
      settings.client_id = client_id;
      settings.client_secret = client_secret;
      settings.redirect_url = redirect_url;
      setSettings(settings);

      client = new AuthAPIClient(settings);

      const authURL = client.getAuthUrl({
        redirectURI: redirect_url,
        scope: permission_scopes,
        nonce: nonce(8),
        enableMock: true, // enable mock/testing provider(s)
      });

      // Used 'target=_blank' since TrueLayer doesn't support inner html.
      res.type('html');
      console.log(authenticate_template);
      const html = authenticate_template
        .replace('__AUTH_URL__', authURL);
      res.send(html);
    });
});

// Step 3: Get token
app.get('/ui/truelayer-redirect', (req, res) => {
  getSettings()
    .then(async (settings) => {
      const { redirect_url } = settings;
      const code = req.query.code;
      const tokens = await client.exchangeCodeForToken(redirect_url, code)
        .catch((error) => {
          console.log('TrueLayer Error: ', error);
          return Promise.reject(new Error(400));
        });
      settings.tokens = tokens;
      const now = new Date();
      settings.tokens.expiration_date = new Date().setMinutes(now.getMinutes() + token_refresh_interval);

      setSettings(settings)
        .then(() => {
          res.redirect('/ui/configure');
        });
    });
});

// Step 4: Configure Driver
// (i.e. choose the Account you want to monitor; only one at the moment)
app.get('/ui/configure', async (req, res) => {
  await validate_token();
  getSettings()
    .then(async (settings) => {
      const { tokens } = settings;

      // get all accounts
      const accounts = await DataAPIClient.getAccounts(tokens.access_token);

      // list them to the user
      let accounts_html = '';
      for(const account of accounts.results) {
        const { account_id, account_type, display_name } = account;
        accounts_html += `<input type="radio" name="account" value="${account_id}"> ${display_name} (<i>${account_type}</i>)<br><br>`;
      }
      res.type('html');
      const html = configure_template
        .replace('__ACCOUNTS__', accounts_html);
      res.send(html);
    })
    .catch((error) => {
      console.log('[configure] Error ', error);
      res.status(400).send({ statusCode: 400, body: 'error in configuration.' });
    });
});

// Step 5: Parse response and save configuration
app.get('/ui/saveConfiguration', function (req, res) {
  const newAccount = req.query.account;
  const newRefreshInterval = req.query.refresh_interval;
  console.log(newAccount);
  console.log(newRefreshInterval);

  getSettings()
    .then((settings) => {
      settings.account_id = newAccount;
      settings.refresh_interval = newRefreshInterval;
      console.log('[SETTINGS]', settings);
      return setSettings(settings);
    })
    .then((settings) => {

      // Start/Restart monitoring with new settings
      refresh_balance();
      refresh_transactions();
      res.type('html');
      const html = saveConfiguration_template;
      res.send(html);
    })
    .catch((error) => {
      console.log('[saveConfiguration] Error ', error);
      res.status(400).send({ statusCode: 400, body: 'error saving configuration settings.' });
    });
});

app.get('/status', function (req, res) {
  res.send('active');
});

const balance = databox.NewDataSourceMetadata();
balance.Description = 'TrueLayer user Balance data';
balance.ContentType = 'application/json';
balance.Vendor = 'Databox Inc.';
balance.DataSourceType = 'truelayerUserBalance';
balance.DataSourceID = 'truelayerUserBalance';
balance.StoreType = 'ts/blob';

const transactions = databox.NewDataSourceMetadata();
transactions.Description = 'TrueLayer user Transactions data';
transactions.ContentType = 'application/json';
transactions.Vendor = 'Databox Inc.';
transactions.DataSourceType = 'truelayerUserTransactions';
transactions.DataSourceID = 'truelayerUserTransactions';
transactions.StoreType = 'ts/blob';

const driverSettings = databox.NewDataSourceMetadata();
driverSettings.Description = 'TrueLayer driver settings';
driverSettings.ContentType = 'application/json';
driverSettings.Vendor = 'Databox Inc.';
driverSettings.DataSourceType = 'truelayerSettings';
driverSettings.DataSourceID = 'truelayerSettings';
driverSettings.StoreType = 'kv';

store.RegisterDatasource(balance)
  .then(() => {
    return store.RegisterDatasource(transactions);
  })
  .then(() => {
    return store.RegisterDatasource(driverSettings);
  })
  .catch((err) => {
    console.log('Error registering data source:' + err);
  });

function getSettings() {
  const datasourceid = 'truelayerSettings';
  return new Promise((resolve, reject) => {
    store.KV.Read(datasourceid, 'settings')
      .then((settings) => {
        console.log('[getSettings] read response = ', settings);
        if (Object.keys(settings).length === 0) {
          //return defaults
          const settings = TrueLayerDefaultSettings;
          //console.log('[getSettings] using defaults Using ----> ', settings);
          resolve(settings);
          return;
        }

        //console.log('[getSettings]', settings);
        resolve(settings);
      })
      .catch((err) => {
        const settings = TrueLayerDefaultSettings;
        console.log('Error getting settings', err);
        console.log('[getSettings] using defaults Using ----> ', settings);
        resolve(settings);
      });
  });
}

function setSettings(settings) {
  const datasourceid = 'truelayerSettings';
  return new Promise((resolve, reject) => {
    store.KV.Write(datasourceid, 'settings', settings)
      .then(() => {
        //console.log('[setSettings] settings saved', settings);
        resolve(settings);
      })
      .catch((err) => {
        console.log('Error setting settings', err);
        reject(err);
      });
  });
}

async function save(datasourceid, data) {
  console.log('Saving TrueLayer event::', data);
  const json = { data };
  store.TSBlob.Write(datasourceid, json)
    .then((resp) => {
      console.log('Save got response ', resp);
    })
    .catch((error) => {
      console.log('Error writing to store:', error);
    });
}

// Will check token validity and if it is due to expire, it will refresh it
async function validate_token() {
  getSettings()
    .then(async (settings) => {
      const { tokens } = settings;

      // check with current datetime
      const now = new Date();
      if (tokens.expiration_date < now) {
        console.log('[refreshing token]');
        const new_token = await client.refreshAccessToken(tokens.refresh_token)
          .catch((error) => {
            console.log('TrueLayer Error: ', error);
            return Promise.reject(new Error(400));
          });
        settings.tokens = new_token;
        settings.tokens.expiration_date = new Date().setMinutes(now.getMinutes() + token_refresh_interval);
        await setSettings(settings);
      }  // else, just continue
    });
}

async function timer_callback() {
  await validate_token();
  getSettings()
    .then((settings) => {
      const { refresh_interval } = settings;

      // check with current datetime
      const now = new Date();
      if (next_data_refresh == null ||
          next_data_refresh < now) {

        // refresh
        refresh_balance();
        refresh_transactions();

        // plan next refresh
        next_data_refresh = new Date().setMinutes(now.getMinutes() + refresh_interval);
      }
    });
}

function refresh_balance() {
  getSettings()
    .then(async (settings) => {
      const { tokens, account_id } = settings;

      console.log('[refresh_balance]');

      const balance = await DataAPIClient.getBalance(tokens.access_token, account_id);
      save('truelayerUserBalance', balance);
    });
}

function refresh_transactions() {
  getSettings()
    .then(async (settings) => {
      const { tokens, account_id, retrieve_from } = settings;

      // save current datetime
      const new_retrieve_from = new Date();

      console.log('Refreshing transactions from: ' + retrieve_from);
      const transactions = await DataAPIClient.getTransactions(tokens.access_token, account_id, retrieve_from);
      save('truelayerUserTransactions', transactions);

      // save datetime for next refresh
      settings.retrieve_from = new_retrieve_from;
      setSettings(settings);
    });
}

//when testing, we run as http, (to prevent the need for self-signed certs etc);
if (DATABOX_TESTING) {
  console.log('[Creating TEST http server]', PORT);
  http.createServer(app).listen(PORT);
} else {
  console.log('[Creating https server]', PORT);
  const credentials = databox.GetHttpsCredentials();
  https.createServer(credentials, app).listen(PORT);
}
