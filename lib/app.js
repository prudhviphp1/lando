'use strict';

// Modules
const _ = require('lodash');
const AsyncEvents = require('./events');
const Engine = require('./engine');
const format = require('util').format;
const hasher = require('object-hash');
const Log = require('./logger');
const Metrics = require('./metrics');
const os = require('os');
const path = require('path');
const Plugins = require('./plugins');
const Promise = require('./promise');
const utils = require('./utils');
const Yaml = require('./yaml');

class App {
  constructor(
    name,
    configFile,
    config = {},
    gconfig = {userConfRoot = os.tempDir()} = {},
    tasks = {},
    engine = new Engine(),
    metrics = new Metrics(),
    log = new Log(),
    plugins = new Plugins(),
    message = {}
  ) {
    // Big things
    this.name = _.replace(_.toLower(name), ' ', '-');
    this.project = utils.dockerComposify(name);
    this._config = gconfig;
    this._dir = path.join(this._config.userConfRoot, 'compose', this.project);
    this._message = message;
    this._name = name;
    // Core properties
    this.config = config;
    this.configFile = configFile;
    this.composeData = [];
    this.engine = engine;
    this.env = this._config.appEnv;
    this.events = new AsyncEvents(log);
    this.info = [];
    this.labels = this._config.appLabels;
    this.log = log;
    this.opts = {};
    this.plugins = plugins;
    this.metrics = metrics;
    this.root = path.dirname(configFile);
    this.scanner = require('./scan')(log);
    this.services = [];
    this.tasks = tasks;
    this.urls = [];
    this.yaml = new Yaml();
    // Computed properties
    this.id = hasher(`${this.name}-${this.configFile}`);
    // Other properties ?
    // this.info = {};
    // this.mount = '/app';
    // this.webroot = config.webroot || '.';
    // this.version = version || '3.2';
    // @TODO: Cached metadata, when do we merge that shit in?
  };

  /*
   * @TODO
   */
  init() {
    // Log some things
    this.log.verbose('Initiatilizing app %s from %s', this.name, this.root);
    this.log.debug('App %s uses config %j', this.name, this.config);

    // If we have compose files lets mix them in since this is step one
    // @TODO: do we need an app.add method or some such that all "compose" additions
    // @TODO: use our service classes
    // can benefit from
    if (!_.isEmpty(_.get(this, 'config.compose', []))) {
      this.composeData = _(utils.validateFiles(this.config.compose, this.root))
        .map((file, index) => ({id: `compose-${index}`, data: this.yaml.load(file)}))
        .value();
    }

    // Find any app plugins and do the mappings
    const plugins = _(this.plugins.find([this.root]))
      .map(plugin => _.merge({}, plugin, {app: plugin.path}))
      .value();
    // Load any core plugins with app.js
    // Start this off by looking for and loading dem plugins
    return Promise.resolve(_.concat(this.plugins.registry, plugins))
    // Filter out
    .filter(plugin => _.has(plugin, 'app'))
    // @TODO: this seems weird, do we need plugin loading to be smarter?
    // Change path so it loads the app plugin
    .map(plugin => ({name: plugin.name, path: plugin.app}))
    // LOADEM!
    .map(plugin => this.plugins.load(plugin, this))
    // Remove any naughty shit
    .map(plugin => _.pick(plugin.data, ['config', 'composeData', 'env', 'labels']))
    // Merge minotaur
    .each(result => _.merge(this, result))

    /**
     * Event that allows altering of the app object right after it is
     * instantiated.
     *
     * Note that this is a global event so it is invoked with `lando.events.on`
     * not `app.events.on` See example below:
     *
     * @since 3.0.0
     * @event post_instantiate_app
     * @property {object} config The user's app config.
     * @example
     * // Add some extra app properties to all apps
     * lando.events.on('pre-instantiate-app', 1, function(app) {
     *
     *   // Add in some global container envconsts
     *   app.env.LANDO = 'ON';
     *   app.env.LANDO_HOST_OS = lando.config.os.platform;
     *   app.env.LANDO_HOST_UID = lando.config.engineId;
     *   app.env.LANDO_HOST_GID = lando.config.engineGid;
     *
     * });
     */
    .then(() => this.events.emit('pre-instantiate-app', this))

    // Actually assemble this thing so its ready for that engine
    .then(() => {
      // Get all services and then frontload the compose array?
      // @TODO: where do we restrict this eg _rebuildOnly
      this.services = _(this.composeData).flatMap(file => _.keys(file.data.services)).value();

      // Get our global composeData
      // @TODO: use our service classes
      // @TODO: without service classes, why is this so jank ass?
      const prime = _(this.services)
        .map(service => ({environment: this.env, labels: this.labels}))
        .map((service, index) => _.set({}, this.services[index], service))
        .thru(services => _.reduce(services, (sum, service) => _.merge(sum, service), {}))
        .value();
      this.composeData.unshift({id: 'globals-0', data: {services: prime}});

      // @TODO: need app.info/app.urls as well?
      this.compose = _(this.composeData)
        .map(data => _.merge({}, data, {file: path.join(this._dir, `${data.id}.yml`)}))
        // @TODO: where does teh version come from here?
        .map(data => this.yaml.dump(data.file, _.merge({}, data.data, {version: '3.2'})))
        .value();

      // Log
      this.log.verbose('App %s has compose files %j', this.project, this.compose);


      this.log.info('App %s is ready!', this.name);
      this.log.debug('App %s has config', this.name, this.config);
    })

    /**
     * Event that allows altering of the app object right after it has been
     * full instantiated and all its plugins have been loaded.
     *
     * The difference between this event and `post-instantiate-app` is that at
     * this point the event has been handed off from the global `lando.events.on`
     * context to the `app.events.on` context. This means that `post-instantiate-app` will
     * run for ALL apps that need to be instantiated while `app-ready` will run
     * on an app to app basis.
     *
     * @since 3.0.0
     * @event app_ready
     * @example
     * // Add logging to report on our apps properties after its full dialed
     * app.events.on('app-ready', function() {
     *
     *   // Log
     *   lando.log.verbose('App %s has global env.', app.name, app.env);
     *   lando.log.verbose('App %s has global labels.', app.name, app.labels);
     *   lando.log.verbose('App %s adds process env.', app.name, app.processEnv);
     *
     * });
     */
     .then(() => this.events.emit('post-instantiate-app', this));
  };

  /**
   * Prints useful information about the app's services.
   *
   * This should return information about the services the app is running,
   * URLs the app can be accessed at, relevant connection information like database
   * credentials and any other information that is added by other plugins.
   *
   * @since 3.0.0
   * @alias lando.app.info
   * @fires pre_info
   * @fires post_info
   * @param {Object} app - A fully instantiated app object
   * @return {Promise} A Promise with an object of information about the app keyed by its services
   * @example
   *
   * // Return the app info
   * return lando.app.info(app)
   *
   * // And print out any services with urls
   * .each(function(service) {
   *   if (_.has(service, 'urls')) {
   *     console.log(service.urls);
   *   }
   * });
   */
  inspect() {
    /**
     * Event that allows other things to add useful metadata to the apps services.
     *
     * Its helpful to use this event to add in information for the end user such as
     * how to access their services, where their code exsts or relevant credential info.
     *
     * @since 3.0.0
     * @event pre_info
     * @example
     *
     * // Add urls to the app
     * app.events.on('pre-info', function() {
     *   return getUrls(app);
     * });
     */
    return this.init().then(() => this.events.emit('pre-info'))
    .then(() => {
      // Rebase any current info on top of our defaults
      // @TODO: guessing we can add more here than just service name and urls?
      // @TODO: add container up/down info?
      this.info = _.merge(utils.getInfoDefaults(this), this.info);
      // Get list of containers
      return this.engine.list(this.name)
      // Return running containers
      .filter(container => this.engine.isRunning(container.id))
      // Inspect each and add new URLS
      .map(container => this.engine.scan(container))
      .map(data => utils.getUrls(data))
      .map(data => _.merge(_.find(this.info, {service: data.service}), data));
    })

    /**
     * Event that allows other things to add useful metadata to the apps services.
     *
     * Its helpful to use this event to add in information for the end user such as
     * how to access their services, where their code exsts or relevant credential info.
     *
     * @since 3.0.0
     * @event post_info
     */
    .then(() => this.events.emit('post-info'))

    // Return app info
    .then(() => this.info);
  };

  /*
   * @TODO
   */
  message(...args) {
    const content = format(...args);
    return this._message({
      app: this.name,
      context: 'app',
      message: content,
      type: 'info',
    })
    .then(() => {
      this.log.info(content);
    });
  };

  /**
   * Starts an app.
   *
   * This will start up all services/containers that have been defined for this app.
   *
   * @since 3.0.0
   * @alias lando.app.start
   * @fires pre_start
   * @fires post_start
   * @param {Object} app - A fully instantiated app object
   * @return {Promise} A Promise.
   * @example
   *
   * // Start the app
   * return lando.app.start(app)
   *
   * // Catch any errors
   * catch(function(err) {
   *   lando.log.error(err);
   * });
   *
   */
  start() {
    // Log
    this.message('Starting app name %s!', this.name);
    // Initialize and kick it off
    // @TODO: Register app. here or in init?
    // .tap(app => register({name: app.registry, lando: app.name, dir: app.root}))
    return this.init().then(() => this.metrics.report('start', utils.metricsParse(this)))

    /**
     * Event that runs before an app starts up.
     *
     * This is useful if you want to start up any support services before an app
     * stars.
     *
     * @since 3.0.0
     * @event pre_start
     * @example
     *
     * // Start up a DNS server before our app starts
     * app.events.on('pre-start', function() {
     *   return lando.engine.start(dnsServer);
     * });
     */
    .then(() => this.events.emit('pre-start'))

    // Start core containers
    .then(() => this.engine.start(this))

    /**
     * Event that runs after an app is started.
     *
     * This is useful if you want to perform additional operations after an app
     * starts such as running additional build commands.
     *
     * @since 3.0.0
     * @event post_start
     * @example
     *
     * // Go through each service and run additional build commands as needed
     * app.events.on('post-start', function() {
     *
     *   // Start up a build collector
     *   const build = [];
     *
     *   // Go through each service
     *   _.forEach(app.config.services, function(service, name) {
     *
     *     // If the service has run steps let's loop through and run some commands
     *     if (!_.isEmpty(service.run)) {
     *
     *       // Normalize data for loopage
     *       if (!_.isArray(service.run)) {
     *         service.run = [service.run];
     *       }
     *
     *       // Run each command
     *       _.forEach(service.run, function(cmd) {
     *
     *         // Build out the compose object
     *         const compose = {
     *           id: [service, name, '1'].join('_'),
     *             cmd: cmd,
     *             opts: {
     *             mode: 'attach'
     *           }
     *         };
     *
     *         // Push to the build
     *         build.push(compose);
     *
     *       });
     *
     *     }
     *
     *   });
     *
     *   // Only proceed if build is non-empty
     *   if (!_.isEmpty(build)) {
     *
     *    // Get the last build cache key
     *    const key = app.name + ':last_build';
     *
     *    // Compute the build hash
     *    const newHash = lando.node.hasher(app.config.services);
     *
     *    // If our new hash is different then lets build
     *    if (lando.cache.get(key) !== newHash) {
     *
     *      // Set the new hash
     *      lando.cache.set(key, newHash, {persist:true});
     *
     *      // Run all our post build steps serially
     *      return lando.engine.run(build);
     *
     *    }
     *   }
     * });
     */
    .then(() => this.events.emit('post-start'))
    // Inspect and scan
    .then(() => this.inspect().then(() => this.scanner(_.flatMap(this.info, 'urls'), {max: 16})))
    .then(urls => this.urls = urls);
  };

  /**
   * Stops an app.
   *
   * This will stop all services/containers that have been defined for this app.
   *
   * @since 3.0.0
   * @alias lando.app.stop
   * @fires pre_stop
   * @fires post_stop
   * @param {Object} app - A fully instantiated app object
   * @return {Promise} A Promise.
   * @example
   *
   * // Stop the app
   * return lando.app.stop(app)
   *
   * // Catch any errors
   * catch(function(err) {
   *   lando.log.error(err);
   * });
   *
   */
  stop() {
    // Stop it!
    this.message('Stopping %s', this.name);
    // Initialize and kick it off
    return this.init().then(() => this.metrics.report('stop', utils.metricsParse(this)))

    /**
     * Event that runs before an app stops.
     *
     * @since 3.0.0
     * @event pre_stop
     * @example
     *
     * // Stop a DNS server before our app stops.
     * app.events.on('pre-stop', function() {
     *   return lando.engine.stop(dnsServer);
     * });
     */
    .then(() => this.events.emit('pre-stop'))

    // Stop components.
    .then(() => this.engine.stop(this))

    /**
     * Event that runs after an app stop.
     *
     * @since 3.0.0
     * @event post_stop
     * @example
     *
     * // Stop a DNS server after our app stops.
     * app.events.on('post-stop', function() {
     *   return lando.engine.stop(dnsServer);
     * });
     */
    .then(() => this.events.emit('post-stop'));
  };

  /**
   * Stops and then starts an app.
   *
   * This just runs `app.stop` and `app.start` in succession.
   *
   * @since 3.0.0
   * @alias lando.app.restart
   * @fires pre_stop
   * @fires post_stop
   * @fires pre_start
   * @fires post_start
   * @param {Object} app - A fully instantiated app object
   * @return {Promise} A Promise.
   * @example
   *
   * // Restart the app
   * return lando.app.restart(app)
   *
   * // Catch any errors
   * catch(function(err) {
   *   lando.log.error(err);
   * });
   *
   */
  restart() {
    // Start it off
    this.message('Restarting %s', this.name);
    // stop/start
    return this.stop().then(() => this.start());
  };

  /**
   * Soft removes the apps services but maintains persistent data like app volumes.
   *
   * This differs from `destroy` in that destroy will hard remove all app services,
   * volumes, networks, etc as well as remove the app from the appRegistry.
   *
   * @since 3.0.0
   * @alias lando.app.uninstall
   * @fires pre_uninstall
   * @fires post_uninstall
   * @param {Boolean} purge - A fully instantiated app object
   * @return {Promise} A Promise.
   * @example
   *
   * // Uninstall the app
   * return lando.app.uninstall(app)
   *
   * // Catch any errors
   * catch(function(err) {
   *   lando.log.error(err);
   * });
   *
   */
  uninstall(purge = false) {
    // Cleaning up
    this.message('Uninstalling %s', this.name);
    // Initialize and kick it off
    return this.metrics.report('uninstall', utils.metricsParse(this))

    /**
     * Event that runs before an app is uninstalled.
     *
     * This is useful if you want to add or remove parts of the uninstall process.
     * For example, it might be nice to persist a container whose data you do not
     * want to replace in a rebuild and that cannot persist easily with a volume.
     *
     * @since 3.0.0
     * @event pre_uninstall
     * @example
     *
     * // Do not uninstall the solr service
     * app.events.on('pre-uninstall', function() {
     *   delete app.services.solr;
     * });
     */
    .then(() => this.events.emit('pre-uninstall'))

    // Kill components.
    .then(() => this.engine.destroy(_.merge({}, this, {opts: {purge}})))

    /**
     * Event that runs after an app is uninstalled.
     *
     * This is useful if you want to do some additional cleanup steps after an
     * app is uninstalled such as invalidating any cached data.
     *
     * @since 3.0.0
     * @event post_uninstall
     * @example
     *
     * // Make sure we remove our build cache
     * app.events.on('post-uninstall', function() {
     *   lando.cache.remove(app.name + '.last_build');
     * });
     */
    .then(() => this.events.emit('post-uninstall'));
  };


  /**
   * Hard removes all app services, olumes, networks, etc as well as removes the
   * app from the appRegistry.
   *
   * This differs from `uninstall` in that uninstall will only soft remove all app
   * services, while maintaining things like volumes, networks, etc as well as an
   * entry in the appRegistry.
   *
   * That said this DOES call both `stop` and `uninstall`.
   *
   * @since 3.0.0
   * @alias lando.app.destroy
   * @fires pre_destroy
   * @fires pre_stop
   * @fires post_stop
   * @fires pre_uninstall
   * @fires post_uninstall
   * @fires post_destroy
   * @param {Object} app - A fully instantiated app object
   * @return {Promise} A Promise.
   * @example
   *
   * // Destroy the app
   * return lando.app.destroy(app)
   *
   * // Catch any errors
   * catch(function(err) {
   *   lando.log.error(err);
   * });
   *
   */
  destroy() {
    // Start it off
    this.message('Destroying %s', this.name);

    /**
     * Event that runs before an app is destroyed.
     *
     * @since 3.0.0
     * @event pre_destroy
     * @example
     *
     * // Make sure the proxy is down before we destroy
     * app.events.on('pre-destroy', function() {
     *   if (fs.existsSync(proxyFile)) {
     *     return lando.engine.stop(getProxy(proxyFile));
     *   }
     * });
     */
    return this.events.emit('pre-destroy')

    // Make sure app is stopped.
    .then(() => this.stop())
    // Uninstall app.
    .then(() => this.uninstall(true))
    // @TODO: Remove from appRegistry
    // .then(() => unregister({name: app.registry})))

    /**
     * Event that runs after an app is destroyed.
     *
     * @since 3.0.0
     * @event post_destroy
     * @example
     *
     * // Make sure the proxy is up brought back up after we destroy
     * app.events.on('post-destroy', function() {
     *   return startProxy();
     * });
     */
    .then(() => this.events.emit('post-destroy'));
  };


  /**
   * Rebuilds an app.
   *
   * This will stop an app, soft remove its services, rebuild those services and
   * then, finally, start the app back up again. This is useful for developers who
   * might want to tweak Dockerfiles or compose yamls.
   *
   * @since 3.0.0
   * @alias lando.app.rebuild
   * @fires pre_stop
   * @fires post_stop
   * @fires pre_uninstall
   * @fires post_uninstall
   * @fires pre_start
   * @fires post_start
   * @param {Object} app - A fully instantiated app object
   * @return {Promise} A Promise.
   * @example
   *
   * // Rebuild the app
   * return lando.app.rebuild(app)
   *
   * // Catch any errors
   * catch(function(err) {
   *   lando.log.error(err);
   * });
   *
   */
  rebuild() {
    // Start it off
    this.message('Rebuilding %s', this.name);
    // Stop app.
    return this.stop()

    /**
     * Event that runs before an app is rebuilt.
     *
     * @since 3.0.0
     * @event pre_rebuild
     * @example
     *
     * // Do something
     * app.events.on('post-rebuild', function() {
     *   // Do something
     * });
     */
    .then(() => this.events.emit('pre-rebuild'))
    // Uninstall app
    .then(() => this.uninstall())
    // Repull/build components.
    .then(() => this.engine.build(this))

    /**
     * Event that runs after an app is rebuilt.
     *
     * @since 3.0.0
     * @event post_rebuild
     * @example
     *
     * // Do something
     * app.events.on('post-rebuild', function() {
     *   // Do something
     * });
     */
    .then(() => this.events.emit('post-rebuild'))
    // Install app.
    .then(() => this.start());
  };
};

module.exports = App;