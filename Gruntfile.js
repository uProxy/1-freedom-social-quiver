/**
 * Gruntfile for freedom-social-quiver
 *
 * To build, use "grunt build".
 **/

var fileInfo = require('freedom');
var freedomPrefix = require.resolve('freedom').substr(0,
  require.resolve('freedom').lastIndexOf('freedom') + 8);
var addPrefix = function(file) {
  if (file.indexOf('!') !== 0 && file.indexOf('/') !== 0) {
    return freedomPrefix + file;
  }
  return file
}
var FILES = {
  src: [
    'src/**/*.js'
  ]
};

FILES.karma = fileInfo.unGlob([].concat(
  fileInfo.FILES.srcCore,
  fileInfo.FILES.srcPlatform,
  fileInfo.FILES.srcJasmineHelper,
  fileInfo.FILES.srcProviderIntegration
).map(addPrefix));
FILES.karma.include = FILES.karma.include.concat(
  FILES.specHelper, 
  FILES.spec
);
console.log(FILES);

module.exports = function (grunt) {
  /**
   * GRUNT CONFIG
   **/
  grunt.initConfig({
    pkg: grunt.file.readJSON('package.json'),
    browserify: {
      main: {
        src: 'src/socketio.quiver.js',
        dest: 'dist/socketio.quiver.js'
      },
      options: {
        browserifyOptions: {
          debug: true,
        }
      }
    },
    copy: {
      dist: {
        src: ['src/socketio.quiver.json'],
        dest: 'dist/',
        flatten: true, filter: 'isFile', expand: true
      }
    },
    jshint: {
      src: {
        files: { src: FILES.src },
        options: { jshintrc: true }
      },
      options: { '-W069': true }
    },
    yuidoc: {
      compile: {
        name: '<%= pkg.name %>',
        description: '<%= pkg.description %>',
        version: '<%= pkg.version %>',
        options: {
          paths: 'src/',
          outdir: 'doc/'
        }
      }
    },
    closureCompiler: {
      options: {
        compilerFile: 'closure/compiler.jar',
        checkModified: false,
        compilerOpts: {
           compilation_level: 'SIMPLE_OPTIMIZATIONS', // 'ADVANCED_OPTIMIZATIONS',
           externs: ['externs/*.js'],
           warning_level: 'verbose',
           jscomp_off: ['fileoverviewTags'], //'checkTypes', 
           summary_detail_level: 3
        },
        d32: false, // true will use 'java -client -d32 -jar compiler.jar'
        TieredCompilation: false // will use 'java -server -XX:+TieredCompilation -jar compiler.jar'
      },
      mainTarget: {
        src: 'src/socketio.quiver.js', // FILES.src,
        dest: 'closure/output.js'
      }
    },
    clean: ['dist/'],
    connect: {
      default: {
        options: {
          port: 8000,
          keepalive: false,
          base: ["./", "./node_modules/freedom/"]
        }
      },
    },
    gitinfo: {}
  });

  // Load tasks.
  grunt.loadNpmTasks('grunt-browserify');
  grunt.loadNpmTasks('grunt-contrib-clean');
  grunt.loadNpmTasks('grunt-contrib-connect');
  grunt.loadNpmTasks('grunt-contrib-copy');
  grunt.loadNpmTasks('grunt-contrib-jshint');
  grunt.loadNpmTasks('grunt-contrib-yuidoc');
  grunt.loadNpmTasks('grunt-closure-tools');
  
  // Default tasks.
  grunt.registerTask('build', [
    'jshint',
    'browserify',
    'copy:dist',
    'connect:default'
  ]);

  grunt.registerTask('default', ['build']);
};

module.exports.FILES = FILES;
