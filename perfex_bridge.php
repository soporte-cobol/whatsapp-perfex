<?php
/**
 * Bridge para conectar el Bot de IA con la base de datos de Perfex
 * Subir este archivo a la raiz de Perfex CRM
 */

define('BASEPATH', 'dummy');
require_once('app-config.php');

// Seguridad: Token para que solo tu bot pueda consultar
$secret_key = "TU_TOKEN_DE_SEGURIDAD_AQUI"; // <--- Debe coincidir con PERFEX_API_TOKEN en el .env

// Seguridad Extra: Restricción por IP (Altamente recomendado)
// Descomenta las líneas de abajo y pon la IP de tu servidor Node.js
/*
$allowed_ip = '123.123.123.123'; // Reemplaza con la IP real de tu servidor Node
if ($_SERVER['REMOTE_ADDR'] !== $allowed_ip) {
    http_response_code(403);
    die(json_encode(['error' => 'Acceso denegado: IP no autorizada']));
}
*/

header('Content-Type: application/json');

$headers = getallheaders();
if (!isset($headers['Authorization']) || $headers['Authorization'] !== $secret_key) {
    http_response_code(401);
    echo json_encode(['error' => 'No autorizado']);
    exit;
}

$mysqli = new mysqli(APP_DB_HOSTNAME, APP_DB_USERNAME, APP_DB_PASSWORD, APP_DB_NAME);

if ($mysqli->connect_error) {
    die(json_encode(['error' => 'Fallo de conexión']));
}

$action = $_GET['action'] ?? '';
$customer_id = $_GET['customer_id'] ?? '';
$email = $_GET['email'] ?? '';
$phone = $_GET['phone'] ?? '';

$response = [];

switch ($action) {
    case 'get_customer_by_phone':
        // Buscamos en tblcontacts ya que allí residen los teléfonos de los contactos individuales
        // Limpiamos el teléfono de caracteres no numéricos para una búsqueda más flexible
        $cleanPhone = preg_replace('/[^0-9]/', '', $phone);
        $likePhone = "%" . $cleanPhone . "%";
        $stmt = $mysqli->prepare("SELECT userid as customerId, firstname, lastname FROM tblcontacts WHERE phonenumber LIKE ? LIMIT 1");
        $stmt->bind_param("s", $likePhone);
        $stmt->execute();
        $result = $stmt->get_result()->fetch_assoc();
        $response = $result ? $result : ['error' => 'Cliente no encontrado'];
        break;

    case 'get_invoices':
        $stmt = $mysqli->prepare("SELECT id, number, total, date, duedate, status FROM tblinvoices WHERE clientid = ?");
        $stmt->bind_param("i", $customer_id);
        $stmt->execute();
        $response = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        break;

    case 'get_projects':
        $stmt = $mysqli->prepare("SELECT id, name, start_date, deadline, status FROM tblprojects WHERE clientid = ?");
        $stmt->bind_param("i", $customer_id);
        $stmt->execute();
        $response = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        break;

    case 'get_tickets':
        $stmt = $mysqli->prepare("SELECT ticketid, subject, message, status, date FROM tbltickets WHERE email = ?");
        $stmt->bind_param("s", $email);
        $stmt->execute();
        $response = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        break;

    case 'get_estimates':
        $stmt = $mysqli->prepare("SELECT id, number, total, date, expirydate, status FROM tblestimates WHERE clientid = ?");
        $stmt->bind_param("i", $customer_id);
        $stmt->execute();
        $response = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        break;

    case 'get_proposals':
        $stmt = $mysqli->prepare("SELECT id, subject, total, date, open_till, status FROM tblproposals WHERE rel_id = ? AND rel_type = 'customer'");
        $stmt->bind_param("i", $customer_id);
        $stmt->execute();
        $response = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        break;

    default:
        $response = ['error' => 'Acción no válida'];
}

echo json_encode($response, JSON_UNESCAPED_UNICODE);
$mysqli->close();