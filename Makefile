.PHONY: setup dev telegram cli build start pairing

setup:
	npm install

dev:
	npm run dev

telegram:
	npm run telegram

agent:
	npm run telegram

cli:
	npm run cli

build:
	npm run build

start:
	npm run start

pairing:
	npm run pairing -- $(ARGS)
