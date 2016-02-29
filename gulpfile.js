const gulp = require('gulp');
const mocha = require('gulp-mocha');
const istanbul = require('gulp-istanbul');
const file = require('gulp-file');
const webpack = require('webpack-stream');
const child = require('child_process');
const help = require('gulp-task-listing');
const del = require('del');
const eslint = require('gulp-eslint');

gulp.task('help', help);

////////////////////////////////////////
// BUILDING
////////////////////////////////////////

const BUILD_TARGET_FILENAME = 'engine.io.js';
const BUILD_TARGET_DIR = './';

gulp.task('default', ['lint', 'build']);

gulp.task('lint', function () {
  return gulp.src([
    '**/*.js',
    '!node_modules/**',
    '!coverage/',
    '!engine.io.js'
  ])
    .pipe(eslint())
    .pipe(eslint.format())
    .pipe(eslint.failAfterError());
});

gulp.task('build', function () {
  return gulp.src(['lib/*.js', 'lib/transports/*.js'], {
    base: 'lib'
  })
    .pipe(webpack(require('./support/webpack.config.js')))
    .pipe(gulp.dest(BUILD_TARGET_DIR));
});

////////////////////////////////////////
// TESTING
////////////////////////////////////////

const REPORTER = 'dot';
const TEST_FILE = './test/index.js';
const TEST_SUPPORT_SERVER_FILE = './test/support/server.js';
const FILES_TO_CLEAN = [
  'test/support/public/engine.io.js'
];

gulp.task('test', function () {
  if (process.env.hasOwnProperty('BROWSER_NAME')) {
    return testZuul();
  } else {
    return testNode();
  }
});

gulp.task('test-node', testNode);
gulp.task('test-zuul', testZuul);

function testNode () {
  const MOCHA_OPTS = {
    reporter: REPORTER,
    require: [TEST_SUPPORT_SERVER_FILE],
    bail: true
  };
  return gulp.src(TEST_FILE, { read: false })
    .pipe(mocha(MOCHA_OPTS))
    // following lines to fix gulp-mocha not terminating (see gulp-mocha webpage)
    .once('error', function (err) {
      console.error(err.stack);
      cleanFiles(FILES_TO_CLEAN);
      process.exit(1);
    })
    .once('end', function () {
      cleanFiles(FILES_TO_CLEAN);
      process.exit();
    });
}

// runs zuul through shell process
function testZuul () {
  const ZUUL_CMD = './node_modules/zuul/bin/zuul';
  const args = [
    '--browser-name',
    process.env.BROWSER_NAME,
    '--browser-version',
    process.env.BROWSER_VERSION
  ];
  if (process.env.hasOwnProperty('BROWSER_PLATFORM')) {
    args.push('--browser-platform');
    args.push(process.env.BROWSER_PLATFORM);
  }
  args.push(TEST_FILE);
  const zuulChild = child.spawn(ZUUL_CMD, args, { stdio: 'inherit' });
  zuulChild.on('exit', function (code) {
    cleanFiles(FILES_TO_CLEAN);
    process.exit(code);
  });
}

function cleanFiles (globArray) {
  return del.sync(globArray);
}

gulp.task('istanbul-pre-test', function () {
  return gulp.src(['lib/**/*.js'])
    // Covering files
    .pipe(istanbul())
    // Force `require` to return covered files
    .pipe(istanbul.hookRequire());
});

gulp.task('test-cov', ['istanbul-pre-test'], function () {
  return gulp.src(['test/*.js', 'test/support/*.js'])
    .pipe(mocha({
      reporter: REPORTER
    }))
    .pipe(istanbul.writeReports())
    .once('error', function (err) {
      console.error(err.stack);
      process.exit(1);
    })
    .once('end', function () {
      process.exit();
    });
});
