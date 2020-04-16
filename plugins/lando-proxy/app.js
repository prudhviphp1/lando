'use strict';

// Modules
const _ = require('lodash');
const path = require('path');
const utils = require('./lib/utils');

/*
 * Helper to find the ports we need for the proxy
 */
const findProxyPorts = (lando, status) => lando.Promise.try(() => {
  if (_.some(_.values(status))) {
    return scanPorts(lando, status).then(ports => _.merge(lando.config.proxyCurrentPorts, ports));
  } else {
    return lando.engine.list()
    .filter(container => container.name === lando.config.proxyContainer)
    .then(containers => _.isEmpty(containers) ? scanPorts(lando) : lando.config.proxyLastPorts);
  };
});

/*
 * Helper to get all ports
 */
const getAllPorts = (noHttp = false, noHttps = false, config) => {
  const {proxyHttpPort, proxyHttpsPort, proxyHttpFallbacks, proxyHttpsFallbacks} = config;
  const ports = [];
  if (noHttp) {
    ports.push(proxyHttpPort);
    ports.push(proxyHttpFallbacks);
  }
  if (noHttps) {
    ports.push(proxyHttpsPort);
    ports.push(proxyHttpsFallbacks);
  }
  return _.flatten(ports).join(', ');
};

/*
 * Helper to scanPorts
 */
const scanPorts = (lando, status = {http: true, https: true}) => {
  return lando.Promise.all([
    utils.getFirstOpenPort(lando.scanUrls, lando.config.proxyScanHttp),
    utils.getFirstOpenPort(lando.scanUrls, lando.config.proxyScanHttps),
  ])
  // @TODO: below could live in utils and would be easy to test
  .then(results => ({http: results[0], https: results[1]}))
  .then(ports => {
    if (!status.http) delete ports.http;
    if (!status.https) delete ports.https;
    return ports;
  });
};

/*
 * @TODO
 */
module.exports = (app, lando) => {
  // Get proxy builder
  const LandoProxy = lando.factory.get('_proxy');
  // Determine what ports we need to discover
  const protocolStatus = utils.needsProtocolScan(lando.config.proxyCurrentPorts, lando.config.proxyLastPorts);
  // Only do things if the proxy is enabled
  // @TODO: below is nasty and probably isn't precise enough
  if (lando.config.proxy === 'ON' && (!_.isEmpty(app.config.proxy) || !_.isEmpty(app.config.recipe))) {
    app.events.on('pre-start', 1, () => findProxyPorts(lando, protocolStatus)
      // Make sure the proxy is running with the correct settings
      .then(ports => {
        // Fail immediately with a warning if we dont have the ports we need
        if (_.isEmpty(ports.http) || _.isEmpty(ports.https)) {
          const allPorts = getAllPorts(_.isEmpty(ports.http), _.isEmpty(ports.https), lando.config);
          return Promise.reject(`Lando could not detect an open port amongst: ${allPorts}`);
        }
        // Build the proxy
        const proxyData = new LandoProxy(ports.http, ports.https, lando.config);
        const proxyFiles = lando.utils.dumpComposeData(proxyData, path.join(lando.config.userConfRoot, 'proxy'));
        // Start the proxy
        return lando.engine.start(utils.getProxyRunner(lando.config.proxyName, proxyFiles)).then(() => {
          lando.cache.set(lando.config.proxyCache, ports, {persist: true});
          return ports;
        });
      })

      // Parse the proxy config to get traefix labels
      .then(() => {
        const urlCounts = utils.getUrlsCounts(app.config.proxy);
        if (_.max(_.values(urlCounts)) > 1) {
          lando.log.error('You cannot assign url %s to more than one service!', _.findKey(urlCounts, c => c > 1));
        }
        return utils.parseConfig(app.config.proxy);
      })

      // Map to docker compose things
      .map(service => {
        // Throw error but proceed if we don't have the service
        if (!_.includes(app.services, service.name)) {
          lando.log.error(`${service.name} is a service that does not exist in your app!!!`);
          lando.log.warn('Try running `lando info` and using one of the services listed there.');
          return {};
        }
        service.labels['traefik.docker.network'] = lando.config.proxyNet;
        return {
          services: _.set({}, service.name, {
            networks: {'lando_proxyedge': {}},
            labels: service.labels,
          }),
          networks: {'lando_proxyedge': {external: {name: lando.config.proxyNet}}},
        };
      })

      // Add to our app
      // @NOTE: we can't add this in the normal way since this happens AFTER our app
      // has been initialized
      .then(result => {
        const proxyData = new app.ComposeService('proxy', {}, ...result);
        const proxyFiles = lando.utils.dumpComposeData(proxyData, app._dir);
        app.compose = app.compose.concat(proxyFiles);
        lando.log.verbose('App %s has proxy compose files %j', app.name, proxyFiles);

        // Add proxy URLS to our app info
        _.forEach(['post-start', 'post-init'], event => {
          app.events.on(event, () => {
            // Get last known ports
            const ports = lando.cache.get(lando.config.proxyCache);
            // Map to protocol and add portz
            // @TODO: do something more meaningful below like logging?, obviously starting to not GAS
            if (ports) {
              _(app.info)
                .filter(service => _.has(app, `config.proxy.${service.service}`))
                .flatMap(s => s.urls = _.uniq(s.urls.concat(utils.parse2Info(app.config.proxy[s.service], ports))))
                .value();
            }
          });
        });
      })

      // Warn the user if this fails
      .catch(error => {
        app.warnings.push({
          title: 'Lando was not able to start the proxy',
          detail: [
            `${error}`,
            'The proxy has been disabled for now so you can continue to work.',
            'Check out the docs below, resolve your issue and build this app',
          ],
          url: 'https://docs.lando.dev/config/proxy.htm',
        });
      }));
  }
};
