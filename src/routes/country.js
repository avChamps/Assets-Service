const express = require('express');
const bodyParser = require('body-parser');
const app = express();
const router = express.Router();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
const { Country, State, City } = require('country-state-city');
const { countries } = require('country-data');

router.get('/getCountries', (req, res) => {
    try {
        const countries = Country.getAllCountries();
        if (!countries || countries.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Countries not found',
            });
        }

        res.status(200).json({
            success: true,
            message: 'Countries fetched successfully',
            data: countries,
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Error fetching countries',
            error: error.message,
        });
    }
});

router.post('/getStates', (req, res) => {
    let { countryCode } = req.body;

    // Extract ISO code if it's an object
    if (countryCode && typeof countryCode === 'object' && countryCode.isoCode) {
        countryCode = countryCode.isoCode;
    }

    if (!countryCode) {
        return res.status(400).json({
            success: false,
            message: 'Country code is required',
        });
    }

    try {
        const states = State.getStatesOfCountry(countryCode.toUpperCase());
        if (!states || states.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'States not found',
            });
        }

        res.status(200).json({
            success: true,
            message: 'States fetched successfully',
            data: states,
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Error fetching states',
            error: error.message,
        });
    }
});


router.post('/getCities', (req, res) => {
    const { countryCode, stateCode } = req.body;

    // stateCode can be a string or an object, handle both
    const stateIsoCode = typeof stateCode === 'string' ? stateCode : stateCode?.isoCode;

    if (!countryCode || !stateIsoCode) {
        return res.status(400).json({
            success: false,
            message: 'Country code and state code are required',
        });
    }

    try {
        const cities = City.getCitiesOfState(
            countryCode.toUpperCase(),
            stateIsoCode.toUpperCase()
        );

        if (!cities || cities.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Cities not found',
            });
        }

        res.status(200).json({
            success: true,
            message: 'Cities fetched successfully',
            data: cities,
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Error fetching cities',
            error: error.message,
        });
    }
});


router.get('/getCountryData', (req, res) => {
    try {

        const countryList = Country.getAllCountries();

        const formattedCountries = countryList.map(country => {

            // find matching country from country-data
            const extra = countries[country.isoCode];

            return {
                name: country.name,
                isoCode: country.isoCode,
                phoneCode: country.phonecode || extra?.countryCallingCodes?.[0]?.replace('+',''),
                currency: extra?.currencies?.[0] || null,

                // Flag image (VERY FAST CDN)
                flag: `https://flagsapi.com/${country.isoCode}/flat/64.png`
            };
        });

        res.status(200).json({
            success: true,
            message: 'Country data fetched successfully',
            data: formattedCountries
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            message: 'Error fetching country data',
            error: error.message
        });

    }
});

module.exports = router;
