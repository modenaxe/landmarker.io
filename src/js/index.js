'use strict';

import $ from 'jquery';
import THREE from 'three';
import url from 'url';

import * as utils from './app/lib/utils';
import * as support from './app/lib/support';

var Notification = require('./app/view/notification');

import Config from './app/model/config';
const cfg = Config();

import Intro from './app/view/intro';
import AssetView from './app/view/asset';

import Backend from './app/backend';

import KeyboardShortcutsHandler from './app/view/keyboard';

function resolveBackend (u) {
    console.log(
        'Resolving which backend to use for url:', window.location.href, u,
        'and config:', cfg.get());

    // Found a server parameter >> override to traditionnal mode
    if (u.query.server) {
        const serverUrl = utils.stripTrailingSlash(u.query.server);
        const server = new Backend.Server(serverUrl);
        cfg.clear(); // Reset all stored data, we use the url

        if (!server.demoMode) { // Don't persist demo mode
            cfg.set({
                'BACKEND_TYPE': Backend.Server.Type,
                'BACKEND_SERVER_URL': u.query.server
            }, true);
        } else {
            document.title = document.title + ' - demo mode';
        }

        return resolveMode(server, u);
    }

    const backendType = cfg.get('BACKEND_TYPE');

    if (!backendType) {
        return Intro.open();
    }

    switch (backendType) {
        case Backend.Dropbox.Type:
            return _loadDropbox(u);
        case Backend.Server.Type:
            return _loadServer(u);
    }
}

function restart (serverUrl) {
    cfg.clear();
    const restartUrl = (
        utils.baseUrl() +
        (serverUrl ? `?server=${serverUrl}` : '')
    );
    window.location.replace(restartUrl);
}

var goToDemo = restart.bind(undefined, 'demo');

function retry (msg) {
    Notification.notify({
        msg, type: 'error', persist: true,
        actions: [['Restart', restart], ['Go to Demo', goToDemo]]
    });
}

function _loadServer (u) {
    const server = new Backend.Server(cfg.get('BACKEND_SERVER_URL'));
    u.query.server = cfg.get('BACKEND_SERVER_URL');
    history.replaceState(null, null, url.format(u).replace('?', '#'));
    resolveMode(server, u);
}

function _loadDropbox (u) {

    let dropbox;
    const oAuthState = cfg.get('OAUTH_STATE'),
          token = cfg.get('BACKEND_DROPBOX_TOKEN');

    if (oAuthState) { // We were waiting for redirect

        const urlOk = [
            'state', 'access_token', 'uid'
        ].every(key => u.query.hasOwnProperty(key));

        if (urlOk && u.query.state === oAuthState) {
            cfg.delete('OAUTH_STATE', true);
            dropbox = new Backend.Dropbox(u.query.access_token, cfg);

            delete u.query.access_token;
            delete u.query.token_type;
            delete u.query.state;
            delete u.query.uid;
            u.search = null;
            history.replaceState(null, null, url.format(u).replace('?', '#'));
        } else {
            Notification.notify({
                msg: 'Incorrect Dropbox redirect URL',
                type: 'error'
            });
            Intro.open();
        }
    } else if (token) {
        dropbox = new Backend.Dropbox(token, cfg);
    }

    if (dropbox) {
        dropbox.setMode(cfg.get('BACKEND_DROPBOX_MODE'));
        return dropbox.accountInfo().then(function () {
            _loadDropboxAssets(dropbox, u);
        }, function () {
            Notification.notify({
                msg: 'Could not reach Dropbox servers',
                type: 'error'
            });
            Intro.open();
        });
    } else {
        Intro.open();
    }
}

function _loadDropboxAssets (dropbox, u) {
    const assetsPath = cfg.get('BACKEND_DROPBOX_ASSETS_PATH');

    function _pick () {
        dropbox.pickAssets(function () {
            _loadDropboxTemplate(dropbox, u);
        }, function (err) {
            retry(`Couldn't find assets: ${err}`);
        });
    }

    if (assetsPath) {
        dropbox.setAssets(assetsPath).then(function () {
            _loadDropboxTemplate(dropbox, u);
        }, _pick);
    } else {
        _pick();
    }
}

function _loadDropboxTemplate (dropbox, u) {

    const templatePath = cfg.get('BACKEND_DROPBOX_TEMPLATE_PATH');

    function _pick () {
        dropbox.pickTemplate(function () {
            resolveMode(dropbox, u);
        }, function (err) {
            retry(`Couldn't find template: ${err}`);
        });
    }

    if (templatePath) {
        dropbox.setTemplate(templatePath).then(function () {
            resolveMode(dropbox, u);
        }, _pick);
    } else {
        _pick();
    }
}

function resolveMode (server, u) {
    server.fetchMode().then(function (mode) {
        if (mode === 'mesh' || mode === 'image') {
            initLandmarker(server, mode, u);
        } else {
            retry('Received invalid mode', mode);
        }
    }, function () {
        retry(`Couldn't get mode from server`);
    });
}

function initLandmarker(server, mode, u) {

    console.log('Starting landmarker in ' + mode + ' mode');

    var App = require('./app/model/app');
    var URLState = require('./app/view/url_state');

    // allow CORS loading of textures
    // https://github.com/mrdoob/three.js/issues/687
    THREE.ImageUtils.crossOrigin = '';

    var appInit = {server: server, mode: mode};

    if (u.query.hasOwnProperty('t')) {
        appInit._activeTemplate = u.query.t;
    }

    if (u.query.hasOwnProperty('c')) {
        appInit._activeCollection = u.query.c;
    }

    if (u.query.hasOwnProperty('i')) {
        appInit._assetIndex = u.query.i - 1;
    }

    var app = new App(appInit);

    var SidebarView = require('./app/view/sidebar');
    var ToolbarView = require('./app/view/toolbar');
    var ViewportView = require('./app/view/viewport');
    var HelpOverlay = require('./app/view/help');

    new Notification.AssetLoadingNotification({model: app});
    new SidebarView.Sidebar({model: app});
    new AssetView({model: app, restart: Intro.open});
    new ToolbarView.Toolbar({model: app});
    new HelpOverlay({model: app});

    var viewport = new ViewportView.Viewport({model: app});

    var prevAsset = null;

    app.on('change:asset', function () {
       console.log('Index: the asset has changed');
        viewport.removeMeshIfPresent();
        if (prevAsset !== null) {
            // clean up previous asset
            console.log('Before dispose: ' + viewport.memoryString());
            prevAsset.dispose();
            console.log('After dispose: ' + viewport.memoryString());
        }
        prevAsset = app.asset();
    });

    // update the URL of the page as the state changes
    new URLState({model: app});

    // ----- KEYBOARD HANDLER ----- //
    $(window).off('keydown');
    (new KeyboardShortcutsHandler(app, viewport)).enable();
}

function handleNewVersion () {

    const $topBar = $('#newVersionPrompt');
    $topBar.text(
        'New version has been downloaded in the background, click to reload.');

    $topBar.click(function () {
        window.location.reload(true);
    });

    $topBar.addClass('Display');
}

document.addEventListener('DOMContentLoaded', function () {

    // Check for new version (vs current appcache retrieved version)
    window.applicationCache.addEventListener('updateready', handleNewVersion);
    if(window.applicationCache.status === window.applicationCache.UPDATEREADY) {
        handleNewVersion();
    }

    // Test for IE
    if (support.ie) {
        // Found IE, do user agent detection for now
        // https://github.com/menpo/landmarker.io/issues/75 for progess
        return Notification.notify({
            msg: 'Internet Explorer is not currently supported by landmarker.io, please use Chrome or Firefox',
            persist: true,
            type: 'error'
        });
    }

    // Test for webgl
    if (!support.webgl) {
        return Notification.notify({
            msg: $('<p>It seems your browser doesn\'t support WebGL, which is needed by landmarker.io.<br/>Please visit <a href="https://get.webgl.org/">https://get.webgl.org/</a> for more information<p>'),
            persist: true,
            type: 'error'
        });
    }

    cfg.load();
    Intro.init({cfg});
    var u = url.parse(
        utils.stripTrailingSlash(window.location.href.replace('#', '?')), true);

    $(window).on('keydown', function (evt) {
        if (evt.which === 27) {
            Intro.open();
        }
    });

    resolveBackend(u);
});
