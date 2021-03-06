'use strict';

var path = require('path'),
    stream = require('stream');

var _ = require('lodash'),
    Dockerode = require('dockerode'),
    fs = require('fs-extra'),
    isolated = require('isolated'),
    minimatch = require('minimatch'),
    Q = require('q'),
    tar = require('tar-fs');

var PassThrough = stream.PassThrough;

var DockWorker = function (options) {
  this.options = options;
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

  try {
    this.server.ping(callback);
  } catch (e) {
    callback(e);
  }
};

DockWorker.prototype.hasImage = function (options, callback) {
  var name;
  var tag;

  if (!options) {
    throw new Error('Options are missing.');
  }

  if (!options.name) {
    throw new Error('Name is missing.');
  } else {
    name = options.name;
  }

  if (!callback) {
    if (!callback) {
      throw new Error('Callback is missing.');
    }
  }

  tag = options.tag;

  if (!options.tag) {
    tag = 'latest';
  }

  this.server.listImages(function (err, images) {
    var hasImage;

    if (err) {
      return callback(err);
    }

    hasImage = _.some(images, function (image) {
      return _.some(image.RepoTags, function (repoTag) {
        return repoTag.split(':')[0] === name && repoTag.split(':')[1] === tag;
      });
    });

    callback(null, hasImage);
  });
};

DockWorker.prototype.downloadImage = function (options, callback) {
  var name;
  var tag;

  if (!options) {
    throw new Error('Options are missing.');
  }

  if (!options.name) {
    throw new Error('Name is missing.');
  }

  name = options.name;

  if (!callback) {
    if (!callback) {
      throw new Error('Callback is missing.');
    }
  }

  tag = options.tag;

  if (!tag) {
    tag = 'latest';
  }

  name = name + ':' + tag;

  this.server.pull(name, function (err, pullStream) {
    if (err) {
      return callback(err);
    }

    pullStream.on('data', function (data) {
      data = JSON.parse(data.toString('utf8'));

      if (data.error) {
        callback(new Error(data.error));
        pullStream.removeAllListeners();
        pullStream.resume();
      }
    });

    pullStream.once('end', function () {
      pullStream.removeAllListeners();
      callback(null);
    });
  });
};

DockWorker.prototype.buildImage = function (options, callback) {
  var that = this;

  if (!options) {
    throw new Error('Options are missing.');
  }
  if (!options.directory) {
    throw new Error('Directory is missing.');
  }
  if (!options.dockerfile) {
    throw new Error('Dockerfile is missing.');
  }
  if (!options.name) {
    throw new Error('Name is missing.');
  }
  if (!callback) {
    throw new Error('Callback is missing.');
  }

  if (options.tag) {
    options.name = options.name + ':' + options.tag;
  }

  options.preBuild = options.preBuild || function (preBuildOptions, done) {
    done(null);
  };

  isolated(function (errIsolated, tempDirectory) {
    var tarFile,
        tarFileName,
        tarStream,
        tempAppDirectory;

    var getFilesToBeIgnored = function (callbackGetFilesToBeIgnored) {
      if (!options.dockerignore) {
        return callbackGetFilesToBeIgnored(null, []);
      }
      fs.readFile(options.dockerignore, function (errReadFile, data) {
        if (errReadFile) {
          return callbackGetFilesToBeIgnored(errReadFile);
        }
        callbackGetFilesToBeIgnored(null, data.toString('utf8').split('\n'));
      });
    };

    if (errIsolated) {
      return callback(errIsolated);
    }

    getFilesToBeIgnored(function (errGetFilesToBeIgnored, filesToBeIgnored) {
      if (errGetFilesToBeIgnored) {
        return callback(errGetFilesToBeIgnored);
      }

      tempAppDirectory = path.join(tempDirectory, path.basename(options.directory));

      fs.copy(options.directory, tempAppDirectory, {
        preserveTimestamps: false,
        filter: function (sourceFile) {
          var relativeSourceFile = path.relative(options.directory, sourceFile),
              shallBeIgnored;

          if (filesToBeIgnored.length === 0) {
            return true;
          }

          shallBeIgnored = filesToBeIgnored.some(function (fileToBeIgnored) {
            if (!fileToBeIgnored) {
              return false;
            }

            return minimatch(relativeSourceFile, fileToBeIgnored);
          });

          return !shallBeIgnored;
        }
      }, function (errCopyDirectory) {
        if (errCopyDirectory) {
          return callback(errCopyDirectory);
        }

        tarFileName = path.join(tempDirectory, 'image.tar');

        fs.copy(options.dockerfile, path.join(tempAppDirectory, 'Dockerfile'), {
          preserveTimestamps: true
        }, function (errCopyDockerfile) {
          if (errCopyDockerfile) {
            return callback(errCopyDockerfile);
          }

          options.preBuild({
            directory: tempAppDirectory
          }, function (errPreBuild) {
            if (errPreBuild) {
              return callback(errPreBuild);
            }

            tarStream = tar.pack(tempAppDirectory);
            tarStream.once('error', function (errTarStream) {
              callback(errTarStream);

              tarStream.removeAllListeners();
              tarFile.removeAllListeners();
            });

            tarFile = fs.createWriteStream(tarFileName);
            tarFile.once('finish', function () {
              tarStream.removeAllListeners();
              tarFile.removeAllListeners();

              that.server.buildImage(tarFileName, { t: options.name }, function (errBuildImage, res) {
                var hadErrors = false;

                if (errBuildImage) {
                  return callback(errBuildImage);
                }

                res.on('data', function (data) {
                  var status = JSON.parse(data.toString('utf8'));

                  if (status.error) {
                    hadErrors = true;
                    callback(new Error(status.error));
                  }
                });

                res.once('end', function () {
                  if (hadErrors) {
                    return;
                  }
                  callback(null);
                });

                res.resume();
              });
            });

            tarStream.pipe(tarFile);
          });
        });
      });
    });
  });
};

DockWorker.prototype.startContainer = function (options, callback) {
  var containerOptions;

  if (!options) {
    throw new Error('Options are missing.');
  }

  if (!options.image) {
    throw new Error('Image is missing.');
  }

  if (options.tag) {
    options.image = options.image + ':' + options.tag;
  }

  if (!options.name) {
    throw new Error('Name is missing.');
  }

  if (!callback) {
    throw new Error('Callback is missing.');
  }

  containerOptions = {
    Image: options.image,
    name: options.name,
    HostConfig: {
      RestartPolicy: {
        Name: 'no'
      }
    }
  };

  if (options.restart) {
    containerOptions.HostConfig.RestartPolicy = {
      Name: 'always'
    };
  }

  if (options.env) {
    containerOptions.Env = [];
    _.forOwn(options.env, function (value, key) {
      containerOptions.Env.push(key.toUpperCase() + '=' + value);
    });
  }

  if (options.volumes) {
    containerOptions.Volumes = {};
    _.forEach(options.volumes, function (volume) {
      containerOptions.Volumes[volume.container] = {};
    });

    containerOptions.HostConfig.Binds = [];
    _.forEach(options.volumes, function (volume) {
      containerOptions.HostConfig.Binds.push(volume.host + ':' + volume.container);
    });
  }

  if (options.ports) {
    containerOptions.ExposedPorts = {};
    _.forEach(options.ports, function (portFowarding) {
      containerOptions.ExposedPorts[portFowarding.container + '/tcp'] = {};
    });

    containerOptions.HostConfig.PortBindings = {};
    _.forEach(options.ports, function (portFowarding) {
      containerOptions.HostConfig.PortBindings[portFowarding.container + '/tcp'] = [
        { HostPort: '' + portFowarding.host }
      ];
    });
  }

  if (options.links) {
    containerOptions.HostConfig.Links = [];
    _.forOwn(options.links, function (link) {
      containerOptions.HostConfig.Links.push(link.name + ':' + link.alias);
    });
  }

  if (options.network && options.network.hosts) {
    containerOptions.HostConfig.ExtraHosts = [];
    _.forOwn(options.network.hosts, function (host) {
      containerOptions.HostConfig.ExtraHosts.push(host.name + ':' + host.ip);
    });
  }

  this.server.createContainer(containerOptions, function (errCreateContainer, container) {
    if (errCreateContainer) {
      return callback(errCreateContainer);
    }

    container.start(function (err) {
      if (err) {
        return callback(err);
      }
      callback(null, container.id);
    });
  });
};

DockWorker.prototype.getRunningContainersFor = function (options, callback) {
  var that = this;
  var name;

  if (!options) {
    throw new Error('Options are missing.');
  }

  if (!options.name) {
    throw new Error('Name is missing.');
  } else {
    name = options.name;
  }

  if (options.tag) {
    name = name + ':' + options.tag;
  }

  if (!callback) {
    throw new Error('Callback is missing.');
  }

  that.server.listContainers(function (errListContainers, containerInfos) {
    var inspectContainers = [];

    if (errListContainers) {
      return callback(errListContainers);
    }

    _.forEach(containerInfos, function (containerInfo) {
      var container = that.server.getContainer(containerInfo.Id);
      var deferred = Q.defer();

      container.inspect(function (errInspect, data) {
        if (errInspect) {
          return deferred.reject(errInspect);
        }
        deferred.resolve(data);
      });

      inspectContainers.push(deferred.promise);
    });

    Q.all(inspectContainers).done(function (containers) {
      containers = _.filter(containers, function (container) {
        if ((typeof name === 'object') && (name instanceof RegExp)) {
          return name.test(container.Config.Image);
        }

        return container.Config.Image === name;
      });

      containers = _.map(containers, function (container) {
        var environmentVariables = container.Config.Env,
            links = container.HostConfig.Links,
            network = {
              hosts: container.HostConfig.ExtraHosts
            },
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

        links = _.map(links, function (link) {
          var parts = link.split(':');

          return {
            name: parts[0].substring(parts[0].lastIndexOf('/') + 1),
            alias: parts[1].substring(parts[1].lastIndexOf('/') + 1)
          };
        });

        network.hosts = _.map(network.hosts, function (hostEntry) {
          var parts = hostEntry.split(':');

          return {
            name: parts[0],
            ip: parts[1]
          };
        });

        volumes = _.map(volumes, function (volume) {
          var parts = volume.split(':');

          return {
            container: parts[1],
            host: parts[0]
          };
        });

        return {
          env: environmentVariables,
          image: container.Config.Image,
          links: links,
          name: container.Name.substring(1),
          network: network,
          ports: ports,
          volumes: volumes
        };
      });

      callback(null, containers);
    }, function (err) {
      callback(err);
    });
  });
};

DockWorker.prototype.getLogs = function (name, callback) {
  var container;

  if (!name) {
    throw new Error('Name is missing.');
  }

  if (!callback) {
    throw new Error('Callback is missing.');
  }

  container = this.server.getContainer(name);

  container.attach({
    stream: true,
    stdout: true,
    stderr: true
  }, function (err, containerStream) {
    /* eslint-disable extended/consistent-err-names */
    var streamErr = new PassThrough(),
        streamOut = new PassThrough();

    if (err) {
      return callback(err);
    }

    container.modem.demuxStream(containerStream, streamOut, streamErr);

    callback(null, streamOut, streamErr);
    /* eslint-enable extended/consistent-err-names */
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

    container.remove({ v: true }, callback);
  });
};

module.exports = DockWorker;
