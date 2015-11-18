freedom-social-quiver
=======================

Multi-server Social Provider for Freedom.
Abstractly, this provider's connection arrangement looks a little bit like a https://en.wikipedia.org/wiki/Quiver_(mathematics)

This code is derived from https://github.com/freedomjs/freedom/tree/master/providers/social/websocket-server .

Building Quiver
--------
To build Quiver, run "grunt build".  The outputs will be in the dist/ folder.

To check Quiver with the Closure Compiler, first download the latest compiler.jar into the closure/ directory,
and then run "grunt closureCompiler".
