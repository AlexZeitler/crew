'use strict';

var _ = require('lodash'),
    Dockerode = require('dockerode'),
    Q = require('q');

var DockWorker = function (options) {
  this.server = new Dockerode({
    protocol: options.protocol,
    host: options.host,
    port: options.port,
    key: options.keys.privateKey,
    cert: options.keys.certificate,
    ca: options.keys.caCertificate
  });
};

DockWorker.prototype.ping = function (callback) {
  if (!callback) {
    throw new Error('Callback is missing.');
  }

  this.server.ping(callback);
};

DockWorker.prototype.hasImage = function (name, callback) {
  if (!name) {
    throw new Error('Name is missing.');
  }

  if (!callback) {
    throw new Error('Callback is missing.');
  }

  this.server.listImages(function (err, images) {
    var hasImage;

    if (err) {
      return callback(err);
    }

    hasImage = _.some(images, function (image) {
      return _.some(image.RepoTags, function (repoTag) {
        return repoTag.split(':')[0] === name;
      });
    });

    callback(null, hasImage);
  });
};

DockWorker.prototype.downloadImage = function (name, callback) {
  if (!name) {
    throw new Error('Name is missing.');
  }

  if (!callback) {
    throw new Error('Callback is missing.');
  }

  this.server.pull(name, function (err, stream) {
    if (err) {
      return callback(err);
    }

    stream.on('data', function (data) {
      data = JSON.parse(data.toString('utf8'));

      if (data.error) {
        callback(new Error(data.error));
        stream.removeAllListeners();
        stream.resume();
      }
    });

    stream.on('end', function () {
      stream.removeAllListeners();
      callback(null);
    });
  });
};

DockWorker.prototype.startContainer = function (options, callback) {
  var containerStartOptions,
      createContainerOptions;

  if (!options) {
    throw new Error('Options are missing.');
  }

  if (!options.image) {
    throw new Error('Image is missing.');
  }

  if (!options.name) {
    throw new Error('Name is missing.');
  }

  if (!callback) {
    throw new Error('Callback is missing.');
  }

  createContainerOptions = {
    Image: options.image,
    name: options.name
  };

  if (options.ports) {
    createContainerOptions.ExposedPorts = {};
    _.forEach(options.ports, function (portFowarding) {
      createContainerOptions.ExposedPorts[portFowarding.container + '/tcp'] = {};
    });
  }

  if (options.env) {
    createContainerOptions.Env = [];
    _.forOwn(options.env, function (value, key) {
      createContainerOptions.Env.push(key.toUpperCase() + '=' + value);
    });
  }

  if (options.volumes) {
    createContainerOptions.Volumes = {};
    _.forEach(options.volumes, function (volume) {
      createContainerOptions.Volumes[volume.container] = {};
    });
  }

  this.server.createContainer(createContainerOptions, function (err, container) {
    if (err) {
      return callback(err);
    }

    containerStartOptions = {};

    if (options.ports) {
      containerStartOptions.PortBindings = {};
      _.forEach(options.ports, function (portFowarding) {
        containerStartOptions.PortBindings[portFowarding.container + '/tcp'] = [
          { HostPort: '' + portFowarding.host }
        ];
      });
    }

    if (options.volumes) {
      containerStartOptions.Binds = [];
      _.forEach(options.volumes, function (volume) {
        containerStartOptions.Binds.push(volume.host + ':' + volume.container);
      });
    }

    container.start(containerStartOptions, function (err) {
      if (err) {
        return callback(err);
      }
      callback(null, container.id);
    });
  });
};

DockWorker.prototype.getRunningContainersFor = function (name, callback) {
  var that = this;

  if (!name) {
    throw new Error('Name is missing.');
  }

  if (!callback) {
    throw new Error('Callback is missing.');
  }

  that.server.listContainers(function (err, containerInfos) {
    var inspectContainers = [];

    if (err) {
      return callback(err);
    }

    _.forEach(containerInfos, function (containerInfo) {
      var container = that.server.getContainer(containerInfo.Id);
      var deferred = Q.defer();

      container.inspect(function (err, data) {
        if (err) {
          return deferred.reject(err);
        }
        deferred.resolve(data);
      });

      inspectContainers.push(deferred.promise);
    });

    Q.all(inspectContainers).done(function (containers) {
      containers = _.filter(containers, function (container) {
        return container.Config.Image === name;
      });

      containers = _.map(containers, function (container) {
        var environmentVariables = container.Config.Env,
            ports = container.HostConfig.PortBindings,
            volumes = container.HostConfig.Binds;

        ports = _.map(ports, function (value, key) {
          return {
            container: key.split('/')[0] - 0,
            host: value[0].HostPort - 0
          };
        });

        environmentVariables = _.map(environmentVariables, function (environmentVariable) {
          var parts = environmentVariable.split('=');
          return {
            key: parts[0],
            value: parts[1]
          };
        });

        environmentVariables = _.object(
          _.pluck(environmentVariables, 'key'),
          _.pluck(environmentVariables, 'value')
        );

        volumes = _.map(volumes, function (volume) {
          var parts = volume.split(':');
          return {
            container: parts[1],
            host: parts[0]
          };
        });

        return {
          image: name,
          name: container.Name.substring(1),
          ports: ports,
          env: environmentVariables,
          volumes: volumes
        };
      });

      callback(null, containers);
    }, function (err) {
      callback(err);
    });
  });
};

DockWorker.prototype.stopContainer = function (name, callback) {
  var container;

  if (!name) {
    throw new Error('Name is missing.');
  }

  if (!callback) {
    throw new Error('Callback is missing.');
  }

  container = this.server.getContainer(name);

  container.kill(function (err) {
    if (err) {
      return callback(err);
    }

    container.remove(callback);
  });
};

module.exports = DockWorker;