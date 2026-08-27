# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: fare-flow-live.spec.js >> live Mongo fare refresh >> does not overlap GPS reads or route requests during reconnect and slow routing
- Location: tests/fare-flow-live.spec.js:463:3

# Error details

```
Error: page.evaluate: TypeError: map.getLayer is not a function
    at removeDriverMapLine (http://127.0.0.1:37239/driver:1534:11)
    at removeRouteLine (http://127.0.0.1:37239/driver:1679:3)
    at refreshActiveNavigation (http://127.0.0.1:37239/driver:1796:43)
    at async Promise.all (index 0)
    at async eval (eval at evaluate (:311:30), <anonymous>:34:9)
    at async <anonymous>:337:30
```