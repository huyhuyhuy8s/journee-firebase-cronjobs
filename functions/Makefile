bootstrap:
	yarn

dev:
	yarn run shell

lint:
	yarn lint

lint-fix:
	yarn lint:fix

serve:
	firebase emulators:start --only functions

shell:
	firebase functions:shell

start:
	npm run shell

deploy:
	yarn lint:fix
	firebase deploy --only functions

logs:
	firebase functions:log
