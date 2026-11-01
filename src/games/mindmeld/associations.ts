/**
 * What people actually say next: free associations for the commonest family
 * words, hand-written, most likely first.
 *
 * Word vectors know which words appear near each other in text, which is not
 * the same as what a person says when asked "what goes with beach?". Trained on
 * news, they offer "palm" and "phoenix" where a person says "sand" and "summer".
 * This is the cure: a short list per word, blended into the bot's choice
 * (`vectorBrain.ts`), so that where a table's two words are ordinary ones the
 * bot reaches for what a person would. Written from how people play the game,
 * not extracted from any dataset, so there is nothing to attribute.
 *
 * Symmetric: if "beach" lists "sand", then "sand" is offered for "beach" even
 * if "sand" has no entry of its own, with the listed direction preferred.
 */

const RAW = `
beach: sand sun ocean sea summer water vacation shore waves swim tan towel shell
sun: summer hot sky light day warm beach bright shine yellow moon star
moon: night star sky dark space light full cheese
star: night sky moon bright shine space twinkle sun galaxy
sky: blue cloud bird plane sun clouds moon star high
cloud: sky rain white storm fluffy weather gray
rain: storm wet water cloud umbrella weather drop puddle thunder
snow: winter cold ice white christmas snowman flake cold sled
wind: air storm breeze blow kite cold weather
storm: rain thunder lightning wind cloud dark weather
fire: hot flame burn smoke red warm campfire match heat
ice: cold water snow freeze cube winter cream skate
water: ocean drink wet sea river rain swim blue fish
ocean: sea water wave beach blue fish deep shark
sea: ocean water wave beach ship blue salt
river: water lake stream fish flow bridge boat
lake: water fish boat swim river cabin blue
mountain: hill climb snow tall hike rock peak valley
forest: trees woods green animals camp wolf bear
tree: leaf forest green wood branch bark apple tall
flower: rose garden petal bee spring smell colorful
grass: green lawn field garden cow mow
garden: flower plant tree grass vegetable seed backyard
farm: cow barn animals tractor corn pig horse field
desert: sand hot camel dry cactus sun
island: beach ocean palm sea tropical boat
jungle: monkey tree tiger green animal rain forest
dog: cat puppy bone bark pet walk tail fetch leash
cat: dog kitten meow pet mouse fur milk purr
bird: fly wing nest tree feather sky egg sing
fish: water swim ocean sea fin shark hook bowl
horse: ride farm saddle gallop animal pony cowboy
cow: milk farm moo barn grass cheese
pig: farm mud pink bacon oink
sheep: wool farm lamb sleep field
mouse: cat cheese small computer rat tail
rabbit: carrot hop bunny ears easter fluffy
lion: tiger king jungle roar zoo mane cat
tiger: lion stripes jungle cat orange zoo
bear: honey forest cub brown teddy sleep
monkey: banana tree jungle zoo ape swing
elephant: trunk big zoo gray circus ears
snake: slither reptile scales poison snake
spider: web insect legs bug scary
bee: honey flower sting buzz hive wasp
butterfly: wings flower caterpillar colorful fly
duck: pond quack water bird egg
chicken: egg farm hen rooster nugget fried
frog: pond hop green toad lily prince
dolphin: ocean fish smart swim flipper
shark: ocean teeth fish fin swim danger
whale: ocean big blue sea fish
eagle: bird fly america sky wings
wolf: howl moon forest dog pack
fox: red clever forest sly
deer: forest antlers hunt bambi animal
dragon: fire castle knight wings scary dinosaur
dinosaur: extinct big fossil dragon t-rex jurassic
pizza: cheese pepperoni italian food slice tomato dough
cheese: pizza mouse milk cheddar cracker wine
bread: butter toast sandwich bake flour loaf
butter: bread toast milk cow knife yellow
milk: cow cookie white drink cereal cheese
egg: breakfast chicken yolk omelet easter shell
cake: birthday sweet candle party frosting cookie
cookie: milk chocolate sweet bake oven jar
candy: sweet sugar halloween chocolate sticky lollipop
chocolate: sweet candy brown cake milk dessert
ice cream: cold cone sweet summer vanilla dessert
apple: fruit red tree pie teacher doctor
banana: yellow fruit monkey peel split
orange: fruit juice color citrus
lemon: yellow sour juice lemonade citrus
strawberry: red fruit jam berry cream
grape: wine fruit purple juice vine
potato: fries chips mash farm vegetable
tomato: red sauce pizza vegetable ketchup
carrot: rabbit orange vegetable
corn: farm yellow popcorn field cob
soup: bowl hot spoon chicken tomato
sandwich: lunch bread ham cheese peanut butter
burger: fries cheese beef bun food
fries: burger potato salt ketchup
coffee: cup morning hot caffeine tea mug
tea: cup hot british coffee green
juice: orange drink apple glass fruit
sugar: sweet candy cake spice
salt: pepper sea ocean shaker
pepper: salt spice hot black
breakfast: morning egg bacon cereal eat toast
dinner: evening food eat family table supper
lunch: noon sandwich school eat midday
kitchen: cook stove food fridge house oven
house: home door roof family garden room
home: house family sweet safe bed
door: open knock house window key lock
window: glass house open view light
room: bed house walls space bedroom
bed: sleep pillow night blanket room
chair: table sit seat leg
table: chair dinner wood eat desk
lamp: light desk bulb shade
clock: time tick hour watch wall
mirror: reflection glass face bathroom
key: lock door open car piano
book: read library story page school
pencil: pen paper write school eraser
paper: write pencil book white tree
school: teacher student class learn books bus
teacher: school student class chalk learn
student: school teacher class study
class: school teacher student room
library: books quiet read school
computer: keyboard mouse screen internet laptop
phone: call text smart ring
television: show watch screen remote movie
music: song dance guitar piano band radio
song: sing music melody radio
guitar: music strings band rock play
piano: keys music play black white
drum: beat band music loud
dance: music party move ballet
movie: popcorn theater film actor cinema
game: play fun board win video
ball: bounce round play throw sport
football: ball team touchdown field sport
soccer: ball goal kick field team
basketball: hoop ball court dunk
baseball: bat ball glove pitcher
tennis: racket ball court net
swim: pool water ocean fish
run: fast jog race legs
jump: high hop rope frog
bike: wheel ride pedal bicycle helmet
car: drive road wheel truck engine
bus: school road drive stop
train: track station railroad engine
plane: fly airport sky wings pilot
boat: water sail sea ship lake
ship: sea boat captain ocean
truck: road drive load big
road: car street drive travel highway
bridge: river cross over span
city: buildings town busy street
town: city village small main
village: small town farm country
street: road house city walk
park: playground tree grass picnic
store: buy shop market money
market: store buy sell fruit
hotel: sleep room travel vacation
hospital: doctor nurse sick patient
doctor: hospital nurse sick medicine health
nurse: hospital doctor sick care
police: officer cop law car arrest
king: queen crown castle royal prince
queen: king crown castle royal
prince: princess king castle charming
princess: prince castle queen crown
castle: king knight tower moat prince
knight: armor sword castle horse shield
wizard: magic wand hat spell
witch: broom halloween magic hat
magic: wand wizard trick spell
ghost: halloween scary boo spooky
monster: scary under bed big
pirate: ship treasure parrot sea
treasure: gold pirate map chest
robot: machine metal future
rocket: space moon launch fly
space: stars planet moon astronaut
planet: earth space sun mars
earth: planet world ground dirt
night: dark moon sleep star
day: sun light bright morning
morning: sun breakfast wake early
summer: sun hot beach vacation
winter: snow cold christmas ice
spring: flower rain bloom easter
autumn: leaves fall orange
fall: autumn leaves down tree
christmas: santa tree presents snow winter gift
birthday: cake party present candle
party: fun birthday music dance
gift: present box birthday bow
santa: christmas claus presents red
halloween: costume candy ghost pumpkin
wedding: bride cake dress marriage
family: mother father home love
mother: father family mom love
father: mother family dad
baby: crib cry small cute
friend: buddy play fun best
love: heart valentine happy family
heart: love red beat valentine
happy: smile joy sad fun
sad: cry unhappy tears blue
angry: mad red fight loud
hot: cold sun fire summer
cold: ice hot winter snow
big: small large giant tall
small: big little tiny short
red: blue apple fire rose
blue: red sky sea ocean
green: grass tree leaf frog
yellow: sun banana lemon
black: white night dark cat
white: black snow cloud
gold: money treasure yellow ring
money: bank dollar cash rich coin
bank: money cash save
work: job office boss
office: work desk computer job
hat: head cap wear cowboy
shoe: foot sock wear lace
shirt: wear clothes tie
coat: winter cold jacket warm
glove: hand winter baseball
sock: foot shoe wear
jacket: coat wear warm
umbrella: rain wet open handle
bag: carry pack purse
watch: time wrist clock
ring: finger wedding gold
crown: king queen head gold
sword: knight fight sharp
shield: knight protect armor
ladder: climb rungs tall
hammer: nail tool build
rope: tie knot climb
paint: brush color art wall
camera: picture photo
picture: photo frame art
map: travel direction treasure
flag: country pole wave
bell: ring church ding
candle: flame light birthday wax
soap: bath clean bubbles
towel: bath dry beach
bath: water soap tub
sleep: bed night dream tired
dream: sleep night wish
travel: trip vacation airport
vacation: beach summer holiday trip
camp: tent fire woods summer
tent: camp sleep woods
`;

/** word -> the words people say after it, best first. */
const TABLE: Map<string, string[]> = (() => {
  const table = new Map<string, string[]>();
  const put = (head: string, word: string) => {
    if (head === word) return;
    const list = table.get(head) ?? [];
    if (list.includes(word)) return;
    list.push(word);
    table.set(head, list);
  };
  for (const line of RAW.split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const head = line.slice(0, colon).trim();
    const words = line.slice(colon + 1).trim().split(/\s+/).filter(Boolean);
    for (const w of words) put(head, w);
  }
  // The other direction, after everything that was written down on purpose.
  for (const line of RAW.split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const head = line.slice(0, colon).trim();
    for (const w of line.slice(colon + 1).trim().split(/\s+/).filter(Boolean)) put(w, head);
  }
  return table;
})();

/** What people say after this word, or none if it is not one of the commonest. */
export function associationsOf(word: string): readonly string[] {
  return TABLE.get(word) ?? [];
}

/** How many words have an entry of their own. */
export function associationHeads(): number {
  return TABLE.size;
}
